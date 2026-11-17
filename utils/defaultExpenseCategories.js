const DEFAULT_EXPENSE_CATEGORY_NAMES = [
    'Rent',
    'Electricity',
    'Water',
    'Internet',
    'Salaries & Wages',
    'Transport & Fuel',
    'Office Supplies',
    'Maintenance & Repairs',
    'Marketing',
    'Professional Fees',
    'Travel',
    'Food & Refreshments',
    'Insurance',
    'Taxes & Licences',
    'Project Materials',
    'Asset Purchase',
    'Other',
];

const defaultExpenseCategories = () =>
    DEFAULT_EXPENSE_CATEGORY_NAMES.map((name) => ({
        key: name,
        name,
        isDefault: true,
        isActive: true,
    }));

const mergeDefaultExpenseCategories = (existing) => {
    const list = Array.isArray(existing) ? existing : [];
    const presentKeys = new Set(
        list
            .filter((cat) => cat && cat.isDefault)
            .map((cat) => String(cat.key || cat.name || '').trim().toLowerCase())
    );
    const missing = defaultExpenseCategories().filter(
        (cat) => !presentKeys.has(String(cat.key).toLowerCase())
    );
    return [...list, ...missing];
};

const ensureExpenseCategories = (details) =>
    mergeDefaultExpenseCategories(details?.expenseCategories);

module.exports = {
    DEFAULT_EXPENSE_CATEGORY_NAMES,
    defaultExpenseCategories,
    mergeDefaultExpenseCategories,
    ensureExpenseCategories,
};
