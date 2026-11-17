const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PDFDocument = require('pdfkit');

const catalogPath = path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'manuals', 'manualCatalog.js');
const source = fs.readFileSync(catalogPath, 'utf8')
    .split('export function getModuleManual')[0]
    .replace('export const MODULE_MANUALS', 'const MODULE_MANUALS');

const sandbox = { module: { exports: {} } };
vm.runInNewContext(`${source}\nmodule.exports = MODULE_MANUALS;`, sandbox);
const manuals = sandbox.module.exports;

const targets = [
    path.join(__dirname, '..', '..', 'frontend', 'public', 'manuals', 'User-Manual.pdf'),
    path.join(__dirname, '..', '..', 'docs', 'User-Manual.pdf'),
];

const clean = (value) => String(value || '')
    .replace(/→/g, '->')
    .replace(/[—–]/g, '-')
    .replace(/≥/g, '>=')
    .replace(/−/g, '-')
    .replace(/•/g, '-');

const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: 'InvoPrint User Manual', Author: 'InvoPrint System' },
});
const chunks = [];
doc.on('data', (chunk) => chunks.push(chunk));
const finished = new Promise((resolve) => doc.on('end', resolve));

doc.fontSize(20).fillColor('#0f172a').text('InvoPrint User Manual', { align: 'center' });
doc.moveDown(0.3).fontSize(9).fillColor('#64748b')
    .text(`InvoPrint System | Version 1.1 | ${new Date().toLocaleDateString('en-GB')}`, { align: 'center' });
doc.moveDown(1);

Object.entries(manuals).forEach(([id, manual], index) => {
    if (index > 0) doc.addPage();

    doc.fontSize(16).fillColor(manual.accent || '#0f172a').text(clean(manual.title));
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor('#475569').text(clean(manual.overview), { lineGap: 2 });
    doc.moveDown(0.8);

    manual.sections.forEach((section, sectionIndex) => {
        doc.fontSize(11).fillColor('#0f172a').text(`${sectionIndex + 1}. ${clean(section.title)}`);
        doc.moveDown(0.3);

        section.blocks.forEach((block) => {
            const prefix = block.type === 'step' ? `${block.n}.` : '-';
            doc.fontSize(9.5).fillColor('#334155')
                .text(`${prefix} ${clean(block.text)}`, { indent: 10, lineGap: 1 });
        });

        doc.moveDown(0.5);
    });
});

doc.end();

finished.then(() => {
    const pdf = Buffer.concat(chunks);
    targets.forEach((target) => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, pdf);
    });
    console.log(`Generated ${targets.length} user manual PDFs (${Object.keys(manuals).length} modules)`);
});
