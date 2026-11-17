const CREDIT_PERIOD_PATTERN = /^\s*(\d+)\s*(day|days|week|weeks|month|months|year|years)\s*$/i;

const parseCreditPeriod = (rawValue, baseDate = new Date()) => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return { error: 'Credit period is required' };
    }

    const label = String(rawValue).trim();
    const match = label.match(CREDIT_PERIOD_PATTERN);
    if (!match) {
        return { error: 'Enter a period like "30 days" or "2 months"' };
    }

    const amount = Number(match[1]);
    if (amount < 1) {
        return { error: 'Credit period must be at least 1' };
    }

    const dueDate = new Date(baseDate);
    if (Number.isNaN(dueDate.getTime())) {
        return { error: 'Invalid credit start date' };
    }

    const unit = match[2].toLowerCase();
    if (unit === 'day' || unit === 'days') {
        dueDate.setDate(dueDate.getDate() + amount);
    } else if (unit === 'week' || unit === 'weeks') {
        dueDate.setDate(dueDate.getDate() + amount * 7);
    } else if (unit === 'month' || unit === 'months') {
        dueDate.setMonth(dueDate.getMonth() + amount);
    } else {
        dueDate.setFullYear(dueDate.getFullYear() + amount);
    }

    if (Number.isNaN(dueDate.getTime())) return { error: 'Invalid credit period' };

    return { dueDate, label };
};

module.exports = { parseCreditPeriod };
