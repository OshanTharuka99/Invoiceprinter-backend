const mongoose = require('mongoose');

const cashReceiptSchema = new mongoose.Schema({
    receiptNumber: {
        type: String,
        required: true,
        unique: true,
        uppercase: true
    },
    receiptType: {
        type: String,
        enum: ['payment', 'advance'],
        default: 'payment'
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
    appliedToInvoice: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Invoice',
        default: null
    },
    appliedAmount: {
        type: Number,
        default: 0,
        min: 0
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
    },
    autoCreated: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('CashReceipt', cashReceiptSchema);