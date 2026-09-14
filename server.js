const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const securityMiddleware = require('./middleware/security');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3001';

// Security headers (Helmet)
app.use(securityMiddleware);

// Middleware
app.use(cors({
    origin: CLIENT_URL,
    credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' })); //read json request
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const businessRoutes = require('./routes/businessRoutes');
const productRoutes = require('./routes/productRoutes');
const clientRoutes = require('./routes/clientRoutes');
const projectRoutes = require('./routes/projectRoutes');
const supplierRoutes = require('./routes/supplierRoutes');
const quotationRoutes = require('./routes/quotationRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const warrantyRoutes = require('./routes/warrantyRoutes');
const purchaseOrderRoutes = require('./routes/purchaseOrderRoutes');
const deliveryNoteRoutes = require('./routes/deliveryNoteRoutes');
const salesReturnRoutes = require('./routes/salesReturnRoutes');
const goodsReturnRoutes = require('./routes/goodsReturnRoutes');
const rmaRoutes = require('./routes/rmaRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const promaInvoiceRoutes = require('./routes/promaInvoiceRoutes');
const cashReceiptRoutes = require('./routes/cashReceiptRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/products', productRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/quotations', quotationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/warranties', warrantyRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/delivery-notes', deliveryNoteRoutes);
app.use('/api/sales-returns', salesReturnRoutes);
app.use('/api/goods-returns', goodsReturnRoutes);
app.use('/api/rma', rmaRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/proma-invoices', promaInvoiceRoutes);
app.use('/api/cash-receipts', cashReceiptRoutes);

app.get('/', (req, res) => {
    res.send('Invoice Printer API is running...');
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 20,
})
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.log('MongoDB connection error:', err));

app.listen(PORT, () => {
    console.log(`Server is running on port: ${PORT}`);
});
