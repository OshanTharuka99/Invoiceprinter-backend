const BusinessDetails = require('../models/BusinessDetails');
const { migrateOrgCodePrefix } = require('../utils/orgCodeMigration');
const { ensureExpenseCategories, mergeDefaultExpenseCategories } = require('../utils/defaultExpenseCategories');

const normalizeExpenseCategories = (categories) => {
    const merged = mergeDefaultExpenseCategories(categories);
    const seen = new Set();
    return merged.map((cat) => {
        const name = String(cat?.name || '').trim();
        if (!name) throw new Error('Expense category name is required');
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error(`Duplicate expense category name: ${name}`);
        seen.add(key);
        return {
            ...(cat._id ? { _id: cat._id } : {}),
            key: cat.key || (cat.isDefault ? name : ''),
            name,
            isDefault: !!cat.isDefault,
            isActive: cat.isActive !== false,
        };
    });
};

exports.getDetails = async (req, res) => {
    try {
        let details = await BusinessDetails.findOne();
        
        // If no details exist, create a default one
        if (!details) {
            details = await BusinessDetails.create({
                businessName: 'My Business',
                businessType: 'Owner',
                address: 'Not Set',
                phoneNumber: 'Not Set',
                email: 'business@example.com',
                country: 'Sri Lanka',
                city: 'Not Set'
            });
        }

        // Seed default expense categories (defaults can be renamed/disabled but never removed)
        const seededCategories = ensureExpenseCategories(details);
        if (!details.expenseCategories || details.expenseCategories.length !== seededCategories.length) {
            details.expenseCategories = seededCategories;
            await details.save();
        }

        res.status(200).json({ status: 'success', data: { details } });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

exports.updateDetails = async (req, res) => {
    try {
        // Restrict to ROOT or ADMIN roles only - though handled in routes, good to have here too
        if (req.user.role !== 'root' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only ROOT or ADMIN users can edit business details.' });
        }

        const payload = { ...req.body };

        if (payload.expenseCategories !== undefined) {
            payload.expenseCategories = normalizeExpenseCategories(payload.expenseCategories);
        }

        let details = await BusinessDetails.findOne();

        // When the organization code changes, migrate existing custom IDs to the new code
        let orgCodeMigration = null;
        if (details && payload.organizationCode !== undefined) {
            orgCodeMigration = await migrateOrgCodePrefix(details.organizationCode, payload.organizationCode);
        }

        if (!details) {
            details = await BusinessDetails.create(payload);
        } else {
            details = await BusinessDetails.findOneAndUpdate({}, { ...payload, updatedBy: req.user._id }, {
                new: true,
                runValidators: true
            });
        }

        res.status(200).json({
            status: 'success',
            data: { details },
            ...(orgCodeMigration ? { orgCodeMigration } : {})
        });
    } catch (error) {
        res.status(400).json({ status: 'fail', message: error.message });
    }
};
