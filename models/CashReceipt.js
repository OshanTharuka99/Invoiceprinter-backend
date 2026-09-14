const mongoose = require('mongoose');

const cashReceiptSchema = new mongoose.Schema({
    receiptNumber: {
        type: String,
        required: true,
        unique: true,
        uppercase: true
    },
    receiptDate: {
        type: Date,
        default: Date.now
    },
    clientRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        default: null
    },
    manualClientDetails: {
        organization: { type: String, trim: true, default: '' },
        name: { type: String, trim: true, default: '' },
        telephoneNumber: { type: String, trim: true, default: '' },
        address: { type: String, trim: true, default: '' }
    },
    amountReceived: {
        type: Number,
        required: true,
        min: 0
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'cheque', 'bank_transfer'],
        default: 'cash'
    },
    chequeNumber: {
        type: String,
        trim: true,
        default: ''
    },
    projectRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project',
        default: null
    },
    quotationRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Quotation',
        default: null
    },
    invoiceRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Invoice',
        default: null
    },
    description: {
        type: String,
        trim: true,
        default: ''
    },
    receivedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['issued', 'void'],
        default: 'issued'
    },
    voidNote: {
        type: String,
        trim: true,
        default: ''
    },
    voidedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('CashReceipt', cashReceiptSchema);