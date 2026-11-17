const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    action: {
        type: String,
        required: true,
        enum: [
            'STOCK_EDIT', 'STOCK_ENTRY_CREATED', 'STOCK_ENTRY_DELETED',
            'PRODUCT_EDIT', 'CATEGORY_EDIT',
            'WARRANTY_SERIAL_EDIT', 'WARRANTY_VOIDED',
            'INVENTORY_REQUEST_APPROVED', 'INVENTORY_REQUEST_REJECTED',
            'RMA_CREATED', 'RMA_REPLACE', 'FAULTY_STOCK_ADDED', 'FAULTY_REMOVED', 'STOCK_LOSS_WRITEOFF',
            'SUPPLIER_CREDIT_PAYMENT'
        ]
    },
    targetType: {
        type: String,
        required: true,
        enum: ['StockEntry', 'Product', 'Category', 'Warranty', 'RmaJob', 'FaultyDevice', 'Supplier']
    },
    targetId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    targetName: {
        type: String,
        default: ''
    },
    details: {
        type: Object,
        default: {}
    },
    reason: {
        type: String,
        default: ''
    },
    performedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', auditLogSchema);
