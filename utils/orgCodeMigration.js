const BusinessDetails = require('../models/BusinessDetails');
const { OBJECT_SHORTS } = require('./objectId');
const Client = require('../models/Client');
const Product = require('../models/Product');
const Project = require('../models/Project');
const Supplier = require('../models/Supplier');
const Category = require('../models/Category');
const StockEntry = require('../models/StockEntry');
const GoodsReturnNote = require('../models/GoodsReturnNote');
const Expense = require('../models/Expense');

const MIGRATABLE_FIELDS = [
    { model: Client, field: 'clientId' },
    { model: Product, field: 'productId' },
    { model: Project, field: 'projectId' },
    { model: Supplier, field: 'supplierId' },
    { model: Category, field: 'code' },
    { model: StockEntry, field: 'batchRef' },
    { model: GoodsReturnNote, field: 'batchRef' },
    { model: Expense, field: 'expenseNumber' },
];

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * When the business organization code changes, rewrite every custom Object ID
 * (ORGCODE/SHORT/NNNNN) so it carries the new code, keeping the same format.
 * Matches the 'ORG' default used when no organization code was set.
 */
const migrateOrgCodePrefix = async (oldCode, newCode) => {
    const effectiveOld = String(oldCode || '').trim() || 'ORG';
    const effectiveNew = String(newCode || '').trim() || 'ORG';

    if (effectiveOld === effectiveNew) {
        return { oldCode: effectiveOld, newCode: effectiveNew, updated: 0, results: [], errors: [] };
    }

    const prefix = `${effectiveOld}/`;
    const matchRegex = new RegExp(`^${escapeRegex(effectiveOld)}/`);
    const replaceWith = `${effectiveNew}/`;
    const results = [];
    const errors = [];

    for (const { model, field } of MIGRATABLE_FIELDS) {
        const docs = await model.find({ [field]: { $regex: matchRegex } });
        let updated = 0;

        for (const doc of docs) {
            const value = doc[field];
            if (typeof value === 'string' && value.startsWith(prefix)) {
                doc[field] = value.replace(matchRegex, replaceWith);
                try {
                    await doc.save();
                    updated += 1;
                } catch (err) {
                    errors.push({
                        collection: model.modelName,
                        field,
                        value: doc[field],
                        error: err.message,
                    });
                }
            }
        }

        results.push({ collection: model.modelName, field, updated });
    }

    return {
        oldCode: effectiveOld,
        newCode: effectiveNew,
        updated: results.reduce((sum, r) => sum + r.updated, 0),
        results,
        errors,
    };
};

const CANONICAL_FIELDS = [
    { model: Client, field: 'clientId' },
    { model: Product, field: 'productId' },
    { model: Project, field: 'projectId' },
    { model: Supplier, field: 'supplierId' },
    { model: Category, field: 'code' },
    { model: Expense, field: 'expenseNumber' },
];

/**
 * Discover every org code prefix (first segment before '/') actually present in the
 * canonical ID fields, so legacy codes can be migrated without knowing them upfront.
 */
const collectUsedOrgCodes = async () => {
    const codes = new Set();
    for (const { model, field } of CANONICAL_FIELDS) {
        const values = await model.distinct(field);
        for (const value of values) {
            if (typeof value === 'string' && value.includes('/')) {
                codes.add(value.split('/')[0]);
            }
        }
    }
    return [...codes];
};

/**
 * Backfill: rewrite existing custom IDs (from ANY legacy org code, including the
 * 'ORG' default) so they all carry the current organization code from BusinessDetails.
 * Keeps the exact same format (CODE/SHORT/NNNNN).
 */
const migrateToCurrentOrgCode = async () => {
    const biz = await BusinessDetails.findOne().select('organizationCode').lean();
    const effectiveCurrent = String(biz?.organizationCode || '').trim() || 'ORG';

    const legacyCodes = new Set(await collectUsedOrgCodes());
    if (effectiveCurrent !== 'ORG') legacyCodes.add('ORG');
    legacyCodes.delete(effectiveCurrent);

    const results = [];
    const errors = [];
    let updatedTotal = 0;

    for (const { model, field } of MIGRATABLE_FIELDS) {
        const docs = await model.find({ [field]: { $exists: true, $ne: null } });
        let updated = 0;

        for (const doc of docs) {
            const value = doc[field];
            if (typeof value !== 'string' || !value.includes('/')) continue;

            const segment = value.split('/')[0];
            if (segment === effectiveCurrent || !legacyCodes.has(segment)) continue;

            doc[field] = value.replace(
                new RegExp(`^${escapeRegex(segment)}/`),
                `${effectiveCurrent}/`
            );
            try {
                await doc.save();
                updated += 1;
                updatedTotal += 1;
            } catch (err) {
                errors.push({
                    collection: model.modelName,
                    field,
                    value: doc[field],
                    error: err.message,
                });
            }
        }

        results.push({ collection: model.modelName, field, updated });
    }

    return {
        currentCode: effectiveCurrent,
        legacyCodes: [...legacyCodes],
        updated: updatedTotal,
        results,
        errors,
    };
};

/**
 * Convert legacy-format IDs (created before the org-code ID system, e.g. CLI_0001,
 * AP00001, PRO_ID_0001, SUP_0001) into the current org-code format
 * (CURRENTCODE/SHORT/NNNNN). StockEntry / GoodsReturnNote batch refs that embed a
 * legacy product Id are rewritten so they stay linked to the converted product.
 */
const convertLegacyIds = async () => {
    const biz = await BusinessDetails.findOne().select('organizationCode').lean();
    const current = String(biz?.organizationCode || '').trim() || 'ORG';

    const transform = async (model, field, short) => {
        const docs = await model.find({}).sort({ createdAt: 1 }).lean();

        const newPrefix = `${current}/${short}/`;
        const newRegex = new RegExp(`^${escapeRegex(current)}/${escapeRegex(short)}/(\\d+)$`);
        let maxSeq = 0;

        for (const doc of docs) {
            const value = doc[field];
            if (typeof value === 'string') {
                const match = value.match(newRegex);
                if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
            }
        }

        const oldToNew = new Map();
        let seq = maxSeq;
        let updated = 0;
        const errors = [];

        for (const doc of docs) {
            const value = doc[field];
            if (typeof value !== 'string' || !value || value.startsWith(newPrefix)) continue;

            seq += 1;
            const newValue = `${newPrefix}${String(seq).padStart(5, '0')}`;
            oldToNew.set(value, newValue);
            try {
                await model.updateOne({ _id: doc._id }, { $set: { [field]: newValue } });
                updated += 1;
            } catch (err) {
                errors.push({ value: doc[field], error: err.message });
            }
        }

        return { collection: model.modelName, field, short, updated, errors, oldToNew };
    };

    const clientResult = await transform(Client, 'clientId', OBJECT_SHORTS.Client);
    const productResult = await transform(Product, 'productId', OBJECT_SHORTS.Product);
    const projectResult = await transform(Project, 'projectId', OBJECT_SHORTS.Project);
    const supplierResult = await transform(Supplier, 'supplierId', OBJECT_SHORTS.Supplier);
    const categoryResult = await transform(Category, 'code', OBJECT_SHORTS.Category);

    // Rewrite batch refs that embed legacy product IDs so they reference the new codes
    const productLookup = productResult.oldToNew;
    const productKeys = [...productLookup.keys()].sort((a, b) => b.length - a.length);
    let batchUpdated = 0;
    const batchErrors = [];

    const rewriteBatchField = async (model) => {
        const docs = await model.find({}).lean();
        for (const doc of docs) {
            const value = doc.batchRef;
            if (typeof value !== 'string') continue;
            let next = value;
            for (const oldId of productKeys) {
                if (next.includes(oldId)) next = next.split(oldId).join(productLookup.get(oldId));
            }
            if (next !== value) {
                try {
                    await model.updateOne({ _id: doc._id }, { $set: { batchRef: next } });
                    batchUpdated += 1;
                } catch (err) {
                    batchErrors.push({ value, error: err.message });
                }
            }
        }
    };

    await rewriteBatchField(StockEntry);
    await rewriteBatchField(GoodsReturnNote);

    const results = [clientResult, productResult, projectResult, supplierResult, categoryResult];
    results.push({ collection: 'StockEntry', field: 'batchRef', updated: batchUpdated, errors: batchErrors });
    results.push({ collection: 'GoodsReturnNote', field: 'batchRef', updated: 0, errors: [] });

    return {
        currentCode: current,
        updated: results.reduce((sum, r) => sum + r.updated, 0),
        productIdMapping: Object.fromEntries(productLookup),
        results,
    };
};

module.exports = { migrateOrgCodePrefix, migrateToCurrentOrgCode, convertLegacyIds };