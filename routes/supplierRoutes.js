const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplierController');
const productController = require('../controllers/productController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

router.route('/')
    .get(supplierController.getSuppliers)
    .post(supplierController.createSupplier);

router.get('/credits', restrictTo('admin', 'root'), productController.getSupplierCredits);
router.get('/:id/credit/entries', restrictTo('admin', 'root'), productController.getSupplierCreditEntries);
router.post('/:id/credit/pay', restrictTo('admin', 'root'), productController.paySupplierCredit);

router.route('/:id')
    .put(restrictTo('admin', 'root'), supplierController.updateSupplier)
    .delete(restrictTo('admin', 'root'), supplierController.deleteSupplier);

module.exports = router;
