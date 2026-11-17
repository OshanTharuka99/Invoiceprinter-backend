const mongoose = require('mongoose');
const CashReceipt = require('../models/CashReceipt');
const BusinessDetails = require('../models/BusinessDetails');
require('dotenv').config({ path: './.env' });

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const migrateCashReceiptNumbers = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB connected...');

        const biz = await BusinessDetails.findOne();
        const orgCode = String(biz?.organizationCode || '').trim().toUpperCase() || 'ORG';
        const prefix = String(biz?.cashReceiptPrefix || 'CR').toUpperCase();
        const digits = Number(biz?.cashReceiptDigits || 5);

        const fullPrefix = `${orgCode}/${prefix}/`;
        const newRegex = new RegExp(`^${escapeRegex(fullPrefix)}(\\d+)$`);

        // Find how far the new-format sequence has already gone
        const allNew = await CashReceipt.find({ receiptNumber: newRegex }).sort({ createdAt: 1 }).lean();
        const usedNew = new Set(allNew.map(r => parseInt(r.receiptNumber.substring(fullPrefix.length), 10)));
        let seq = usedNew.size ? Math.max(...usedNew) : 0;

        // Old format: any receipt whose number does NOT already start with the new full prefix
        const bypassRegex = new RegExp(`^${escapeRegex(fullPrefix)}`);
        const legacyReceipts = await CashReceipt.find({
            receiptNumber: { $exists: true, $ne: null, $not: bypassRegex }
        }).sort({ createdAt: 1 });

        let updated = 0;
        const errors = [];

        for (const rec of legacyReceipts) {
            seq += 1;
            const newNumber = `${fullPrefix}${String(seq).padStart(digits, '0')}`;
            try {
                await CashReceipt.updateOne({ _id: rec._id }, { $set: { receiptNumber: newNumber } });
                updated += 1;
                console.log(`  ${rec.receiptNumber} -> ${newNumber}`);
            } catch (err) {
                errors.push({ id: rec._id, receiptNumber: rec.receiptNumber, error: err.message });
            }
        }

        console.log('\n=== Cash Receipt Number Migration Result ===');
        console.log(`Org code: ${orgCode}`);
        console.log(`New format: ${fullPrefix}${String(seq + 1).padStart(digits, '0')} (next)`);
        console.log(`Updated: ${updated}`);
        if (errors.length > 0) {
            console.log('\nErrors:');
            errors.forEach(e => console.log(`  ${e.receiptNumber}: ${e.error}`));
        }

        mongoose.connection.close();
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

migrateCashReceiptNumbers();