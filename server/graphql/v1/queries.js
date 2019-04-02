import Promise from 'bluebird';
import { find, get, uniq } from 'lodash';
import algolia from '../../lib/algolia';
import errors from '../../lib/errors';
import { parseToBoolean } from '../../lib/utils';
import { fetchLedgerTransactionsGroupedByLegacyIds, parseLedgerTransactions } from '../../lib/ledger';
import DbQueries from '../../lib/queries';

import { GraphQLList, GraphQLNonNull, GraphQLString, GraphQLInt, GraphQLBoolean } from 'graphql';

import {
  CollectiveInterfaceType,
  CollectiveSearchResultsType,
  TypeOfCollectiveType,
  CollectiveOrderFieldType,
  HostCollectiveOrderFieldType,
} from './CollectiveInterface';

import { InvoiceInputType } from './inputTypes';

import {
  PaginatedTransactionsType,
  TransactionInterfaceType,
  TransactionType,
  TransactionOrder,
  OrderDirectionType,
} from './TransactionInterface';

import { ApplicationType } from './Application';

import {
  UserType,
  TierType,
  ExpenseStatusType,
  ExpenseType,
  InvoiceType,
  UpdateType,
  MemberType,
  OrderByType,
  OrderType,
  PaginatedExpensesType,
  PaymentMethodType,
} from './types';

import models, { sequelize, Op } from '../../models';
import rawQueries from '../../lib/queries';
import { fetchCollectiveId } from '../../lib/cache';

const queries = {
  Collective: {
    type: CollectiveInterfaceType,
    args: {
      slug: { type: GraphQLString },
      id: { type: GraphQLInt },
    },
    resolve(_, args) {
      let collective;
      if (args.slug) {
        collective = models.Collective.findBySlug(args.slug.toLowerCase());
      } else if (args.id) {
        collective = models.Collective.findByPk(args.id);
      } else {
        return new Error('Please provide a slug or an id');
      }
      if (!collective) {
        throw new errors.NotFound('Collective not found');
      }
      return collective;
    },
  },

  Tier: {
    type: TierType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args) {
      return models.Tier.findByPk(args.id);
    },
  },

  MatchingFund: {
    type: PaymentMethodType,
    description: 'Fetch data about a matching fund from the short version of its UUID (first part)',
    args: {
      uuid: { type: new GraphQLNonNull(GraphQLString) },
      ForCollectiveId: { type: GraphQLInt },
    },
    resolve(_, args) {
      return models.PaymentMethod.getMatchingFund(args.uuid, {
        ForCollectiveId: args.ForCollectiveId,
      });
    },
  },

  LoggedInUser: {
    type: UserType,
    resolve(_, args, req) {
      return req.remoteUser;
    },
  },

  AuthenticatedUser: {
    type: CollectiveInterfaceType,
    resolve(_, args, req) {
      return models.Collective.findByPk(req.remoteUser.CollectiveId);
    },
  },

  allInvoices: {
    type: new GraphQLList(InvoiceType),
    args: {
      fromCollectiveSlug: { type: new GraphQLNonNull(GraphQLString) },
    },
    async resolve(_, args, req) {
      const fromCollective = await models.Collective.findOne({
        where: { slug: args.fromCollectiveSlug },
      });
      if (!fromCollective) {
        throw new errors.NotFound('User or organization not found');
      }
      if (!req.remoteUser || !req.remoteUser.isAdmin(fromCollective.id)) {
        throw new errors.Unauthorized("You don't have permission to access invoices for this user");
      }

      const transactions = await models.Transaction.findAll({
        attributes: ['createdAt', 'HostCollectiveId', 'amountInHostCurrency', 'hostCurrency'],
        where: {
          type: 'CREDIT',
          [Op.or]: [
            { FromCollectiveId: fromCollective.id, UsingVirtualCardFromCollectiveId: null },
            { UsingVirtualCardFromCollectiveId: fromCollective.id },
          ],
        },
      });

      const hostsById = {};
      const invoicesByKey = {};
      await Promise.map(transactions, async transaction => {
        const HostCollectiveId = transaction.HostCollectiveId;
        hostsById[HostCollectiveId] =
          hostsById[HostCollectiveId] ||
          (await models.Collective.findByPk(HostCollectiveId, {
            attributes: ['id', 'slug'],
          }));
        const createdAt = new Date(transaction.createdAt);
        const year = createdAt.getFullYear();
        const month = createdAt.getMonth() + 1;
        const month2digit = month < 10 ? `0${month}` : `${month}`;
        const slug = `${year}${month2digit}.${hostsById[HostCollectiveId].slug}.${fromCollective.slug}`;
        const totalAmount = invoicesByKey[slug]
          ? invoicesByKey[slug].totalAmount + transaction.amountInHostCurrency
          : transaction.amountInHostCurrency;
        invoicesByKey[slug] = {
          HostCollectiveId,
          FromCollectiveId: fromCollective.id,
          slug,
          year,
          month,
          totalAmount,
          currency: transaction.hostCurrency,
        };
      });
      const invoices = [];
      Object.keys(invoicesByKey).forEach(key => invoices.push(invoicesByKey[key]));
      invoices.sort((a, b) => {
        return a.slug > b.slug ? -1 : 1;
      });
      return invoices;
    },
  },

  Invoice: {
    type: InvoiceType,
    args: {
      invoiceInputType: {
        type: InvoiceInputType,
        description:
          'Like the  Slug of the invoice but spilt out into parts and includes dateTo for getting an invoice over a date range.',
      },
      invoiceSlug: {
        type: GraphQLString,
        description: 'Slug of the invoice. Format: :year:2digitMonth.:hostSlug.:fromCollectiveSlug',
      },
    },
    async resolve(_, args, req) {
      const { dateFrom, dateTo, fromCollectiveSlug, collectiveSlug } = args.invoiceSlug
        ? parseInvoiceSlug(args.invoiceSlug)
        : args.invoiceInputType;

      validateDate(dateFrom);
      validateDate(dateTo);

      const fromCollective = await models.Collective.findOne({
        where: { slug: fromCollectiveSlug },
      });
      if (!fromCollective) {
        throw new errors.NotFound(`User or organization not found for slug ${args.fromCollective}`);
      }
      const host = await models.Collective.findBySlug(collectiveSlug);
      if (!host) {
        throw new errors.NotFound('Host not found');
      }
      if (!req.remoteUser || !req.remoteUser.isAdmin(fromCollective.id)) {
        throw new errors.Unauthorized("You don't have permission to access invoices for this user");
      }

      const { year: fromYear, month: fromMonth } = dateFrom;
      const { year: toYear, month: toMonth } = dateTo;

      const startsAt = new Date(`${fromYear}-${fromMonth}-01`);
      const endsAt = new Date(`${toYear}-${toMonth}-01`);

      if (endsAt < startsAt) {
        throw new errors.ValidationFailed(
          'validation_failed',
          ['InvoiceDateType'],
          'Invalid date object. dateFrom must be before dateTo',
        );
      }

      const where = {
        [Op.or]: [
          { FromCollectiveId: fromCollective.id, UsingVirtualCardFromCollectiveId: null },
          { UsingVirtualCardFromCollectiveId: fromCollective.id },
        ],
        HostCollectiveId: host.id,
        createdAt: { [Op.gte]: startsAt, [Op.lt]: endsAt },
        type: 'CREDIT',
      };

      const transactions = await models.Transaction.findAll({ where });
      if (transactions.length === 0) {
        throw new errors.NotFound('No transactions found');
      }

      const invoice = {
        title: get(host, 'settings.invoiceTitle') || 'Donation Receipt',
        HostCollectiveId: host.id,
        slug: args.invoiceSlug,
        yearFrom: fromYear,
        monthFrom: fromMonth,
        yearTo: toYear,
        monthTo: toMonth,
      };

      const totalAmount = transactions.reduce((total, transaction) => {
        invoice.currency = transaction.hostCurrency;
        total += transaction.amountInHostCurrency;
        return total;
      }, 0);

      invoice.FromCollectiveId = fromCollective.id;
      invoice.totalAmount = totalAmount;
      invoice.currency = invoice.currency || host.currency;
      invoice.transactions = transactions;

      return invoice;
    },
  },

  /**
   * Get an invoice for a single transaction.
   */
  TransactionInvoice: {
    type: InvoiceType,
    args: {
      transactionUuid: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Slug of the transaction.',
      },
    },
    async resolve(_, args) {
      // Fetch transaction
      const transaction = await models.Transaction.findOne({
        where: { uuid: args.transactionUuid },
      });

      if (!transaction) {
        throw new errors.NotFound(`Transaction ${args.transactionUuid} doesn't exists`);
      }

      // If using a virtualcard, then billed collective will be the emitter
      const fromCollectiveId = transaction.paymentMethodProviderCollectiveId();

      // Load transaction host
      transaction.host = await transaction.getHostCollective();

      // Get total in host currency
      const totalAmountInHostCurrency =
        transaction.type === 'CREDIT' ? transaction.amount : transaction.netAmountInCollectiveCurrency * -1;

      // Generate invoice
      const invoice = {
        title: get(transaction.host, 'settings.invoiceTitle') || 'Donation Receipt',
        HostCollectiveId: get(transaction.host, 'id'),
        slug: `transaction-${args.transactionUuid}`,
        currency: transaction.hostCurrency,
        FromCollectiveId: fromCollectiveId,
        totalAmount: totalAmountInHostCurrency,
        transactions: [transaction],
        yearFrom: transaction.createdAt.getFullYear(),
        monthFrom: transaction.createdAt.getMonth() + 1,
        day: transaction.createdAt.getDate(),
      };

      return invoice;
    },
  },

  /*
   * Given a collective slug or id, returns all its transactions
   */
  allTransactions: {
    type: new GraphQLList(TransactionInterfaceType),
    description: `
    Given a collective, returns all its transactions:
    - Debit transactions made by collective without using a virtual card
    - Debit transactions made using a virtual card from collective
    - Credit transactions made to collective
    `,
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      type: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      dateFrom: { type: GraphQLString },
      dateTo: { type: GraphQLString },
      /** @deprecated since 2018-11-29: Virtual cards now included by default when necessary */
      includeVirtualCards: { type: GraphQLBoolean },
      fetchDataFromLedger: { type: GraphQLBoolean }, // flag to go with either api or ledger transactions
      includeHostedCollectivesTransactions: {
        type: GraphQLBoolean,
      } /** flag to determine
        whether we should include the transactions of the collectives of that host(if it's a host collective) */,
    },
    async resolve(_, args) {
      let fetchDataFromLedger = parseToBoolean(process.env.GET_TRANSACTIONS_FROM_LEDGER);
      if (args.hasOwnProperty('fetchDataFromLedger')) {
        fetchDataFromLedger = args.fetchDataFromLedger;
      }
      // Load collective
      const { CollectiveId, collectiveSlug } = args;
      if (!CollectiveId && !collectiveSlug) throw new Error('You must specify a collective ID or a Slug');
      const where = CollectiveId ? { id: CollectiveId } : { slug: collectiveSlug };
      const collective = await models.Collective.findOne({ where });
      if (!collective) throw new Error('This collective does not exist');

      // returns transactions straight from the api
      if (!fetchDataFromLedger) {
        return collective.getTransactions({
          order: [['createdAt', 'DESC']],
          type: args.type,
          limit: args.limit,
          offset: args.offset,
          startDate: args.dateFrom,
          endDate: args.dateTo,
        });
      }
      // otherwise returns data from the ledger
      const ledgerTransactions = await fetchLedgerTransactionsGroupedByLegacyIds(args);
      const apiTransactions = await models.Transaction.findAll({
        attributes: [
          'id',
          'uuid', // because the stored invoice pdf in aws uses the uuid as reference
          'UsingVirtualCardFromCollectiveId', // because virtual cards will only work for wallets and we're skipping wallets in the transactions details for now
          'HostCollectiveId', // because we're skipping wallets and using host on transactions details for now
          'RefundTransactionId', // because the ledger refundTransactionId refers to the ledger id and not the legacy one
        ],
        where: {
          id: Object.keys(ledgerTransactions),
        },
      });
      return parseLedgerTransactions(args.CollectiveId, ledgerTransactions, apiTransactions);
    },
  },

  /*
   * Returns all transactions
   */
  transactions: {
    type: PaginatedTransactionsType,
    args: {
      limit: {
        defaultValue: 100,
        description: 'Defaults to 100',
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
      orderBy: {
        defaultValue: TransactionOrder.defaultValue,
        type: TransactionOrder,
      },
      type: {
        description: 'CREDIT or DEBIT are accepted values',
        type: TransactionType,
      },
    },
    async resolve(_, args) {
      const { limit, offset, orderBy, type } = args;
      const query = {
        limit,
        offset,
        order: [Object.values(orderBy)],
        where: {},
      };

      if (type) {
        query.where = { type };
      }

      const [total, transactions] = await Promise.all([
        models.Transaction.count({ where: query.where }),
        models.Transaction.findAll(query),
      ]);

      return {
        limit,
        offset,
        total,
        transactions,
      };
    },
  },

  Update: {
    type: UpdateType,
    args: {
      collectiveSlug: { type: GraphQLString },
      updateSlug: { type: GraphQLString },
      id: { type: GraphQLInt },
    },
    async resolve(_, args) {
      if (args.id) {
        return models.Update.findByPk(args.id);
      }
      const CollectiveId = await fetchCollectiveId(args.collectiveSlug);
      return models.Update.findOne({
        where: { CollectiveId, slug: args.updateSlug },
      });
    },
  },

  Application: {
    type: ApplicationType,
    args: {
      id: { type: GraphQLInt },
    },
    async resolve(_, args) {
      if (args.id) {
        return models.Application.findByPk(args.id);
      } else {
        return new Error('Please provide an id.');
      }
    },
  },

  /*
   * Given an ExpenseId or an UpdateId, returns all comments
   */
  allComments: {
    type: new GraphQLList(UpdateType),
    args: {
      ExpenseId: { type: GraphQLInt },
      UpdateId: { type: GraphQLInt },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve(_, args) {
      const query = { where: {} };
      if (args.ExpenseId) query.where.ExpenseId = args.ExpenseId;
      if (args.UpdateId) query.where.UpdateId = args.UpdateId;
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;
      query.order = [['createdAt', 'ASC']];
      return models.Comment.findAll(query);
    },
  },

  /*
   * Given a collective slug, returns all updates
   */
  allUpdates: {
    type: new GraphQLList(UpdateType),
    args: {
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      includeHostedCollectives: { type: GraphQLBoolean },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve(_, args, req) {
      const query = { where: {} };
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;
      query.order = [['publishedAt', 'DESC'], ['createdAt', 'DESC']];
      if (!req.remoteUser || !req.remoteUser.isAdmin(args.CollectiveId)) {
        query.where.publishedAt = { [Op.ne]: null };
      }
      return req.loaders.collective.findById.load(args.CollectiveId).then(collective => {
        if (!collective) {
          throw new Error('Collective not found');
        }
        const getCollectiveIds = () => {
          // if is host, we get all the updates across all the hosted collectives
          if (args.includeHostedCollectives) {
            return models.Member.findAll({
              where: {
                MemberCollectiveId: collective.id,
                role: 'HOST',
              },
            }).map(member => member.CollectiveId);
          } else {
            return Promise.resolve([args.CollectiveId]);
          }
        };
        return getCollectiveIds().then(collectiveIds => {
          query.where.CollectiveId = { [Op.in]: collectiveIds };
          return models.Update.findAll(query);
        });
      });
    },
  },

  /*
   * Given a collective slug, returns all orders
   */
  allOrders: {
    type: new GraphQLList(OrderType),
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      includeHostedCollectives: { type: GraphQLBoolean },
      status: {
        type: GraphQLString,
        description: 'Filter by status (PAID, PENDING, ERROR, ACTIVE, CANCELLED)',
      },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args) {
      const query = { where: {} };
      const CollectiveId = args.CollectiveId || (await fetchCollectiveId(args.collectiveSlug));
      if (args.status) query.where.status = args.status;
      if (args.category) query.where.category = { [Op.iLike]: args.category };
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;
      query.order = [['id', 'DESC']];
      const getCollectiveIds = () => {
        // if is host, we get all the orders across all the hosted collectives
        if (args.includeHostedCollectives) {
          return models.Member.findAll({
            where: {
              MemberCollectiveId: CollectiveId,
              role: 'HOST',
            },
          }).map(member => member.CollectiveId);
        } else {
          return Promise.resolve([CollectiveId]);
        }
      };
      return getCollectiveIds().then(collectiveIds => {
        query.where.CollectiveId = { [Op.in]: collectiveIds };
        return models.Order.findAll(query);
      });
    },
  },

  /*
   * Given a collective slug, returns all expenses
   */
  allExpenses: {
    type: new GraphQLList(ExpenseType),
    args: {
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      includeHostedCollectives: { type: GraphQLBoolean },
      status: { type: GraphQLString },
      category: { type: GraphQLString },
      FromCollectiveId: { type: GraphQLInt },
      fromCollectiveSlug: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args, req) {
      const query = { where: {} };
      if (args.fromCollectiveSlug && !args.FromCollectiveId) {
        args.FromCollectiveId = await fetchCollectiveId(args.fromCollectiveSlug);
      }
      if (args.FromCollectiveId) {
        const user = await models.User.findOne({
          attributes: ['id'],
          where: { CollectiveId: args.FromCollectiveId },
        });
        if (!user) {
          throw new Error('FromCollectiveId not found');
        }
        query.where.UserId = user.id;
      }
      if (args.status) query.where.status = args.status;
      if (args.category) query.where.category = { [Op.iLike]: args.category };
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;
      query.order = [['incurredAt', 'DESC']];
      return req.loaders.collective.findById.load(args.CollectiveId).then(collective => {
        if (!collective) {
          throw new Error('Collective not found');
        }
        const getCollectiveIds = () => {
          // if is host, we get all the expenses across all the hosted collectives
          if (args.includeHostedCollectives) {
            return models.Member.findAll({
              where: {
                MemberCollectiveId: collective.id,
                role: 'HOST',
              },
            }).map(member => member.CollectiveId);
          } else {
            return Promise.resolve([args.CollectiveId]);
          }
        };
        return getCollectiveIds().then(collectiveIds => {
          query.where.CollectiveId = { [Op.in]: collectiveIds };
          return models.Expense.findAll(query);
        });
      });
    },
  },

  /*
   * Return all expenses, with optional collective slug
   */
  expenses: {
    type: PaginatedExpensesType,
    args: {
      CollectiveId: { type: GraphQLInt },
      CollectiveSlug: { type: GraphQLString },
      status: { type: ExpenseStatusType },
      category: { type: GraphQLString },
      FromCollectiveId: { type: GraphQLInt },
      FromCollectiveSlug: { type: GraphQLString },
      limit: {
        defaultValue: 100,
        description: 'Defaults to 100',
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
      orderBy: {
        defaultValue: OrderByType.defaultValue,
        type: OrderByType,
      },
    },
    async resolve(_, args) {
      const {
        category,
        CollectiveId,
        CollectiveSlug,
        FromCollectiveId,
        FromCollectiveSlug,
        limit,
        offset,
        orderBy,
        status,
      } = args;
      const query = {
        limit,
        offset,
        order: [Object.values(orderBy)],
        where: {},
      };

      if (FromCollectiveId || FromCollectiveSlug) {
        const { id } = await models.User.findOne({
          attributes: ['id'],
          where: {
            CollectiveId: FromCollectiveId || (await fetchCollectiveId(FromCollectiveSlug)),
          },
        });
        query.where.UserId = id;
      }

      if (category) query.where.category = { [Op.iLike]: category };
      if (status) query.where.status = status;

      if (CollectiveId || CollectiveSlug) {
        query.where.CollectiveId = CollectiveId || (await fetchCollectiveId(CollectiveSlug));
      }

      const { count: total, rows: expenses } = await models.Expense.findAndCountAll(query);
      return {
        expenses,
        limit,
        offset,
        total,
      };
    },
  },

  /*
   * Given an Expense id, returns the expense details
   */
  Expense: {
    type: ExpenseType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args) {
      return models.Expense.findByPk(args.id);
    },
  },

  /*
   * Given a Transaction id, returns a transaction details
   */
  Transaction: {
    type: TransactionInterfaceType,
    args: {
      id: {
        type: GraphQLInt,
      },
      uuid: {
        type: GraphQLString,
      },
    },
    resolve(_, args) {
      return models.Transaction.findOne({ where: { ...args } });
    },
  },

  /*
   * Returns all collectives
   */
  allCollectives: {
    type: CollectiveSearchResultsType,
    args: {
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'Fetch all collectives that match at least one of the tags',
      },
      type: {
        type: TypeOfCollectiveType,
        description: 'COLLECTIVE, USER, ORGANIZATION, EVENT',
      },
      HostCollectiveId: {
        type: GraphQLInt,
        description: 'Fetch all collectives hosted by HostCollectiveId',
      },
      hostCollectiveSlug: {
        type: GraphQLString,
        description: 'Fetch all collectives hosted by hostCollectiveSlug',
      },
      isActive: {
        description: 'Only return active collectives',
        type: GraphQLBoolean,
      },
      isPledged: {
        description: 'Only return pledged or non-pledged collectives',
        type: GraphQLBoolean,
      },
      memberOfCollectiveSlug: {
        type: GraphQLString,
        description: 'Fetch all collectives that `memberOfCollectiveSlug` is a member of',
      },
      minBackerCount: {
        description: 'Filter collectives with this minimum number of backers',
        type: GraphQLInt,
      },
      role: {
        type: GraphQLString,
        description: 'Only fetch the collectives where `memberOfCollectiveSlug` has the specified role',
      },
      ParentCollectiveId: {
        type: GraphQLInt,
        description: 'Fetch all collectives that are a child of `ParentCollectiveId`. Used for "SuperCollectives"',
      },
      orderBy: {
        defaultValue: 'name',
        type: CollectiveOrderFieldType,
      },
      orderDirection: {
        defaultValue: 'ASC',
        type: OrderDirectionType,
      },
      limit: {
        defaultValue: 10,
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
    },
    async resolve(_, args) {
      const query = {
        where: {},
        limit: args.limit,
        include: [],
      };

      if (args.hostCollectiveSlug) {
        args.HostCollectiveId = await fetchCollectiveId(args.hostCollectiveSlug);
      }

      if (args.memberOfCollectiveSlug) {
        args.memberOfCollectiveId = await fetchCollectiveId(args.memberOfCollectiveSlug);
      }

      if (args.memberOfCollectiveId) {
        const memberCond = {
          model: models.Member,
          required: true,
          where: {
            MemberCollectiveId: args.memberOfCollectiveId,
          },
        };
        if (args.role) memberCond.where.role = args.role.toUpperCase();
        query.include.push(memberCond);
      }

      if (args.HostCollectiveId) query.where.HostCollectiveId = args.HostCollectiveId;
      if (args.ParentCollectiveId) query.where.ParentCollectiveId = args.ParentCollectiveId;
      if (args.type) query.where.type = args.type;
      if (args.tags) query.where.tags = { [Op.overlap]: args.tags };
      if (typeof args.isActive === 'boolean') query.where.isActive = args.isActive;
      if (typeof args.isPledged === 'boolean') query.where.isPledged = args.isPledged;

      if (args.orderBy === 'balance' && (args.ParentCollectiveId || args.HostCollectiveId || args.tags)) {
        const { total, collectives } = await rawQueries.getCollectivesWithBalance(query.where, args);
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      if (args.orderBy === 'monthlySpending') {
        const { total, collectives } = await rawQueries.getCollectivesOrderedByMonthlySpending({
          ...args,
          where: query.where,
        });
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      if (args.minBackerCount) {
        const { total, collectives } = await rawQueries.getCollectivesWithMinBackers({
          ...args,
          where: query.where,
        });
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      query.order = [[args.orderBy, args.orderDirection]];

      if (args.offset) query.offset = args.offset;

      // this will elminate the odd test accounts and older data we need to cleanup
      query.where = {
        ...query.where,
        createdAt: {
          [Op.not]: null,
        },
        name: {
          [Op.ne]: '',
        },
      };
      const result = await models.Collective.findAndCountAll(query);

      return {
        total: result.count,
        collectives: result.rows,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },

  /*
   * Returns all hosts
   */
  allHosts: {
    type: CollectiveSearchResultsType,
    description: 'Returns all public hosts that are open for applications',
    args: {
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'Fetch all collectives that match at least one of the tags',
      },
      currency: {
        type: GraphQLString,
        description: 'Filter hosts by currency',
      },
      orderBy: {
        defaultValue: 'collectives',
        type: HostCollectiveOrderFieldType,
      },
      orderDirection: {
        defaultValue: 'DESC',
        type: OrderDirectionType,
      },
      limit: {
        defaultValue: 10,
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
    },
    async resolve(_, args) {
      const results = await rawQueries.getPublicHostsByTotalCollectives(args);
      return {
        total: results.length,
        collectives: results,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },

  /**
   * Helper to get all tags used in collectives
   */
  allCollectiveTags: {
    type: new GraphQLList(GraphQLString),
    resolve: DbQueries.getUniqueCollectiveTags,
  },

  /*
   * Given a collective slug, returns all members/memberships
   */
  allMembers: {
    type: new GraphQLList(MemberType),
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      includeHostedCollectives: {
        type: GraphQLBoolean,
        description:
          'Include the members of the hosted collectives. Useful to get the list of all users/organizations from a host.',
      },
      memberCollectiveSlug: { type: GraphQLString },
      TierId: { type: GraphQLInt },
      role: { type: GraphQLString },
      type: { type: GraphQLString },
      isActive: { type: GraphQLBoolean },
      orderBy: { type: GraphQLString },
      orderDirection: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args, req) {
      if (!args.CollectiveId && !args.collectiveSlug && !args.memberCollectiveSlug) {
        throw new Error('Please provide a CollectiveId, a collectiveSlug or a memberCollectiveSlug');
      }

      if (args.collectiveSlug) {
        args.CollectiveId = await fetchCollectiveId(args.collectiveSlug);
      }

      if (args.memberCollectiveSlug) {
        args.MemberCollectiveId = await fetchCollectiveId(args.memberCollectiveSlug);
      }

      const memberTable = args.MemberCollectiveId ? 'collective' : 'memberCollective';
      const attr = args.CollectiveId ? 'CollectiveId' : 'MemberCollectiveId';
      const where = { [attr]: args[attr] };
      if (args.role) where.role = args.role.toUpperCase();
      if (where.role === 'HOST') {
        where.HostCollectiveId = args.MemberCollectiveId;
      }

      const getCollectiveIds = () => {
        if (args.includeHostedCollectives) {
          return models.Member.findAll({
            where: {
              MemberCollectiveId: args.CollectiveId,
              role: 'HOST',
            },
          }).map(members => members.CollectiveId);
        } else {
          return Promise.resolve([args[attr]]);
        }
      };

      if (['totalDonations', 'balance'].indexOf(args.orderBy) !== -1) {
        const queryName = args.orderBy === 'totalDonations' ? 'getMembersWithTotalDonations' : 'getMembersWithBalance';
        const tiersById = {};

        const options = args.isActive ? { ...args, limit: args.limit * 2 } : args;

        return rawQueries[queryName](where, options)
          .then(results => {
            if (args.isActive) {
              const TierIds = uniq(results.map(r => r.dataValues.TierId));
              return models.Tier.findAll({
                where: { id: { [Op.in]: TierIds } },
              }).then(tiers => {
                tiers.map(t => (tiersById[t.id] = t.dataValues));
                return results
                  .filter(r => {
                    return models.Member.isActive({
                      tier: tiersById[r.dataValues.TierId],
                      lastDonation: r.dataValues.lastDonation,
                    });
                  })
                  .slice(0, args.limit);
              });
            }
            return results;
          })
          .map(collective => {
            const res = {
              id: collective.dataValues.MemberId,
              role: collective.dataValues.role,
              createdAt: collective.dataValues.createdAt,
              CollectiveId: collective.dataValues.CollectiveId,
              MemberCollectiveId: collective.dataValues.MemberCollectiveId,
              ParentCollectiveId: collective.dataValues.ParentCollectiveId,
              totalDonations: collective.dataValues.totalDonations,
              TierId: collective.dataValues.TierId,
            };
            res[memberTable] = collective;
            return res;
          });
      } else {
        const query = { where, include: [] };
        if (args.TierId) query.where.TierId = args.TierId;

        // If we request the data of the member, we do a JOIN query
        // that allows us to sort by Member.member.name
        const memberCond = {};
        if (req.body.query.match(/ member ?\{/) || args.type) {
          if (args.type) {
            const types = args.type.split(',');
            memberCond.type = { [Op.in]: types };
          }
          query.include.push({
            model: models.Collective,
            as: memberTable,
            required: true,
            where: memberCond,
          });
          query.order = [[sequelize.literal(`"${memberTable}".name`), 'ASC']];
        }
        if (args.limit) query.limit = args.limit;
        if (args.offset) query.offset = args.offset;

        return getCollectiveIds()
          .then(collectiveIds => {
            query.where[attr] = { [Op.in]: collectiveIds };
            query.where.role = { [Op.ne]: 'HOST' };
            return models.Member.findAll(query);
          })
          .then(members => {
            // also fetch the list of collectives that are members of the host
            if (args.includeHostedCollectives) {
              query.where = {
                MemberCollectiveId: args.CollectiveId,
                role: 'HOST',
              };
              query.order = [[sequelize.literal('collective.name'), 'ASC']];
              query.include = [
                {
                  model: models.Collective,
                  as: 'collective',
                  required: true,
                },
              ];

              return models.Member.findAll(query)
                .map(m => {
                  m.memberCollective = m.collective;
                  delete m.collective;
                  members.push(m);
                })
                .then(() => members);
            } else {
              return members;
            }
          });
      }
    },
  },

  /*
   * Given a collective slug, returns all events
   */
  allEvents: {
    type: new GraphQLList(CollectiveInterfaceType),
    args: {
      slug: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve(_, args) {
      if (args.slug) {
        return models.Collective.findBySlug(args.slug, { attributes: ['id'] })
          .then(collective =>
            models.Collective.findAll({
              where: { ParentCollectiveId: collective.id, type: 'EVENT' },
              order: [['startsAt', 'DESC'], ['createdAt', 'DESC']],
              limit: args.limit || 10,
              offset: args.offset || 0,
            }),
          )
          .catch(() => {
            return [];
          });
      } else {
        return models.Collective.findAll({ where: { type: 'EVENT' } });
      }
    },
  },

  /*
   * Deprecated: Given a prepaid code, return validity and amount
   */
  ocPaymentMethod: {
    type: PaymentMethodType,
    args: {
      token: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve(_, args) {
      return models.PaymentMethod.findOne({
        where: {
          token: args.token,
          expiryDate: {
            [Op.gt]: new Date(),
          },
          archivedAt: null, // archived PMs are assumed to be used or inactive
        },
      });
    },
  },

  /*
   * Given a prepaid code, return validity and amount
   */
  PaymentMethod: {
    type: PaymentMethodType,
    args: {
      id: { type: GraphQLInt },
      code: { type: GraphQLString },
    },
    resolve(_, args) {
      if (args.id) {
        return models.PaymentMethod.findByPk(args.id);
      } else if (args.code) {
        return models.PaymentMethod.findOne({
          where: sequelize.and(
            sequelize.where(sequelize.cast(sequelize.col('uuid'), 'text'), {
              [Op.like]: `${args.code}%`,
            }),
            { service: 'opencollective' },
            { type: 'virtualcard' },
          ),
        });
      } else {
        return new Error('Please provide an id or a code.');
      }
    },
  },

  /*
   * Given a search term, return a list of related Collectives
   */
  search: {
    type: CollectiveSearchResultsType,
    args: {
      term: {
        type: GraphQLString,
        description:
          'Fetch collectives related to this term based on name, description, tags, slug, mission, and location',
      },
      limit: {
        type: GraphQLInt,
        description: 'Limit the amount of results. Defaults to 20',
        defaultValue: 20,
      },
      offset: {
        type: GraphQLInt,
        defaultValue: 0,
      },
    },
    async resolve(_, args) {
      const { limit, offset, term } = args;

      if (term.trim() === '') {
        return {
          collectives: [],
          limit,
          offset,
          total: 0,
        };
      }

      const index = algolia.getIndex();
      if (!index) {
        return { collectives: [], limit, offset, total: 0 };
      }

      const { hits, nbHits: total } = await index.search({
        query: term,
        length: limit,
        offset,
      });
      const collectiveIds = hits.map(({ id }) => id);
      const collectives = await models.Collective.findAll({
        where: {
          id: {
            [Op.in]: collectiveIds,
          },
        },
      });

      // map over the collectiveIds with the database results to keep the original order from Algolia
      // filter out null results
      return {
        collectives: collectiveIds.map(id => find(collectives, { id })).filter(Boolean),
        limit,
        offset,
        total,
      };
    },
  },
  /** Gets the transactions of a payment method
   * @param {Object} args contains the parameters
   * @param {Number} args.uuid The Payment method id
   * @param {String} [args.type] The transaction type - Debit or Credit
   * @param {Number} [args.limit] The limit of records to be returned
   * @param {String} [args.offset] The offset of the query
   * @param {String} [args.dateFrom] The start date(field createdAt) to return the list of transactions
   * @param {String} [args.dateTo] The end date(field createdAt) to return the list of transactions
   * @returns {[models.Transaction]} returns an array of transactions.
   */
  allTransactionsFromPaymentMethod: {
    type: new GraphQLList(TransactionInterfaceType),
    args: {
      uuid: { type: new GraphQLNonNull(GraphQLString) },
      type: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      dateFrom: { type: GraphQLString },
      dateTo: { type: GraphQLString },
    },
    resolve: async (_, args) => {
      const paymentMethod = await models.PaymentMethod.findOne({
        where: { uuid: args.uuid },
      });
      if (!paymentMethod) {
        throw Error(`Payment Method with uuid ${args.uuid} not found.`);
      }
      const query = {
        where: {
          PaymentMethodId: paymentMethod.id,
        },
        order: [['createdAt', 'DESC']],
      };
      if (args.type) query.where.type = args.type;
      if (args.limit) query.limit = args.limit;
      if (args.offset) query.offset = args.offset;

      if (args.dateFrom || args.dateTo) {
        query.where.createdAt = {};
        if (args.dateFrom) query.where.createdAt[Op.gte] = args.dateFrom;
        if (args.dateTo) query.where.createdAt[Op.lte] = args.dateTo;
      }
      const transactions = await models.Transaction.findAll(query);
      return transactions;
    },
  },

  Order: {
    type: OrderType,
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
      },
    },
    resolve: async (_, args) => {
      const order = await models.Order.findByPk(args.id);
      return order;
    },
  },
};

function validateDate(dateObj) {
  if (dateObj.year < 2015 || (dateObj.month < 1 || dateObj.month > 12)) {
    throw new errors.ValidationFailed(
      'validation_failed',
      ['InvoiceDateType'],
      'Invalid date object. Must have a valid month, where 1 == January, and be after 2014',
    );
  }
}

function parseInvoiceSlug(invoiceSlug) {
  const year = invoiceSlug.substr(0, 4);
  const month = invoiceSlug.substr(4, 2);
  const collectiveSlug = invoiceSlug.substring(7, invoiceSlug.lastIndexOf('.'));
  const fromCollectiveSlug = invoiceSlug.substr(invoiceSlug.lastIndexOf('.') + 1);
  if (!collectiveSlug || year < 2015 || (month < 1 || month > 12)) {
    throw new errors.ValidationFailed(
      'Invalid invoiceSlug format. Should be :year:2digitMonth.:hostSlug.:fromCollectiveSlug',
    );
  }
  return {
    dateFrom: {
      year,
      month,
    },
    dateTo: {
      year,
      month: String(Number(month) + 1),
    },
    collectiveSlug,
    fromCollectiveSlug,
  };
}
export default queries;
