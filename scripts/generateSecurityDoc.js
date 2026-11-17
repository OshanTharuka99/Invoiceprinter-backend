const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'docs');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'Security-Updates-Documentation-2026-07-02.pdf');
const DOC_DATE = 'Thursday, 2 July 2026';

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const drawSectionTitle = (doc, title) => {
    doc.moveDown(0.8);
    doc.fillColor('#dc2626').fontSize(14).font('Helvetica-Bold').text(title);
    doc.moveDown(0.3);
    doc.strokeColor('#dc2626').lineWidth(1).moveTo(doc.x, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fillColor('#111827').font('Helvetica');
};

const drawSubTitle = (doc, title) => {
    doc.moveDown(0.4);
    doc.fillColor('#1f2937').fontSize(11).font('Helvetica-Bold').text(title);
    doc.moveDown(0.2);
    doc.fillColor('#374151').fontSize(10).font('Helvetica');
};

const drawParagraph = (doc, text) => {
    doc.text(text, { align: 'justify', lineGap: 3 });
    doc.moveDown(0.3);
};

const drawBulletList = (doc, items) => {
    items.forEach((item) => {
        doc.text(`• ${item}`, { indent: 12, lineGap: 2 });
    });
    doc.moveDown(0.3);
};

const drawTable = (doc, headers, rows) => {
    const startX = 50;
    const colWidths = headers.map(() => (495 / headers.length));
    let y = doc.y;

    doc.font('Helvetica-Bold').fontSize(9);
    headers.forEach((header, i) => {
        doc.text(header, startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0), y, {
            width: colWidths[i],
            continued: false,
        });
    });

    y += 16;
    doc.font('Helvetica').fontSize(9);

    rows.forEach((row) => {
        if (y > 730) {
            doc.addPage();
            y = 60;
        }

        row.forEach((cell, i) => {
            doc.text(String(cell), startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0), y, {
                width: colWidths[i],
                lineGap: 1,
            });
        });

        y += 28;
        doc.y = y;
    });

    doc.moveDown(0.5);
};

const generate = () => {
    ensureDir(OUTPUT_DIR);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(OUTPUT_FILE);
    doc.pipe(stream);

    // Cover
    doc.rect(0, 0, 595, 140).fill('#08090a');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26)
        .text('InvoPrint', 50, 42);
    doc.fillColor('#dc2626').fontSize(26)
        .text(' Security Updates', 170, 42, { continued: false });
    doc.fillColor('#cbd5e1').font('Helvetica').fontSize(12)
        .text('Technical Documentation', 50, 82);
    doc.fillColor('#94a3b8').fontSize(10)
        .text(`Document Date: ${DOC_DATE}`, 50, 104);
    doc.fillColor('#94a3b8').fontSize(10)
        .text('Project: Invoice Printer (MERN Stack)', 50, 118);

    doc.fillColor('#111827').font('Helvetica').fontSize(10);
    doc.y = 170;

    drawSectionTitle(doc, '1. Executive Summary');
    drawParagraph(doc,
        'This document records the security enhancements applied to the Invoice Printer application on 2 July 2026. Two major improvements were implemented: (1) migration of JWT authentication from browser localStorage to HttpOnly cookies, and (2) activation of industrial-grade HTTP security headers using the Helmet middleware library.');
    drawParagraph(doc,
        'These changes reduce exposure to Cross-Site Scripting (XSS) token theft and strengthen the API against common web vulnerabilities such as MIME sniffing, clickjacking, and insecure transport.');

    drawSectionTitle(doc, '2. Change 1 — HttpOnly Cookie Authentication');

    drawSubTitle(doc, '2.1 Problem (Before)');
    drawBulletList(doc, [
        'JWT tokens were returned in JSON and stored in localStorage.',
        'JavaScript could read the token, making it vulnerable to XSS attacks.',
        'Authorization header was manually attached on the frontend.',
    ]);

    drawSubTitle(doc, '2.2 Solution (After)');
    drawBulletList(doc, [
        'JWT is stored in an HttpOnly cookie named "token" on login/register.',
        'Token is no longer included in API JSON responses.',
        'Browser automatically sends the cookie with credentialed requests.',
        'JavaScript cannot access the HttpOnly cookie.',
        'Session is restored via GET /api/auth/me on application load.',
        'Logout clears the cookie via POST /api/auth/logout.',
    ]);

    drawSubTitle(doc, '2.3 Cookie Configuration');
    drawTable(doc, ['Setting', 'Development', 'Production'], [
        ['httpOnly', 'true', 'true'],
        ['secure', 'false', 'true'],
        ['sameSite', 'lax', 'strict'],
        ['maxAge', 'Based on JWT_EXPIRES_IN env', 'Based on JWT_EXPIRES_IN env'],
    ]);

    drawSubTitle(doc, '2.4 New / Updated API Endpoints');
    drawTable(doc, ['Method', 'Endpoint', 'Description'], [
        ['POST', '/api/auth/login', 'Sets HttpOnly cookie; returns user data only'],
        ['POST', '/api/auth/register', 'Sets HttpOnly cookie; returns user data only'],
        ['POST', '/api/auth/logout', 'Clears authentication cookie'],
        ['GET', '/api/auth/me', 'Returns current user if cookie is valid (protected)'],
    ]);

    drawSubTitle(doc, '2.5 Backend Files Modified / Added');
    drawBulletList(doc, [
        'backend/utils/cookieOptions.js — NEW: shared cookie option helper',
        'backend/controllers/authController.js — cookie set/clear, getMe, logout',
        'backend/middleware/auth.js — reads token from cookie or Bearer header',
        'backend/routes/authRoutes.js — logout and /me routes added',
        'backend/server.js — cookie-parser, CORS credentials enabled',
        'backend/package.json — cookie-parser dependency added',
    ]);

    drawSubTitle(doc, '2.6 Frontend Files Modified');
    drawBulletList(doc, [
        'frontend/src/api.js — withCredentials: true for axios',
        'frontend/src/context/AuthContext.jsx — removed localStorage token usage',
        'frontend/src/pages/ForcePasswordChange.jsx — uses updateUser instead of localStorage',
    ]);

    if (doc.y > 620) doc.addPage();

    drawSectionTitle(doc, '3. Change 2 — Helmet Security Headers');

    drawSubTitle(doc, '3.1 Overview');
    drawParagraph(doc,
        'The Helmet library (v8.x) was installed and configured in backend/middleware/security.js. It applies security-related HTTP response headers to all API responses.');

    drawSubTitle(doc, '3.2 Active Security Headers');
    drawTable(doc, ['Header', 'Configuration'], [
        ['Content-Security-Policy', 'Strict API policy: default-src none, frame-ancestors none'],
        ['Strict-Transport-Security', 'Production only: max-age 1 year, includeSubDomains, preload'],
        ['X-Content-Type-Options', 'nosniff'],
        ['X-Frame-Options', 'DENY'],
        ['Cross-Origin-Opener-Policy', 'same-origin'],
        ['Cross-Origin-Resource-Policy', 'cross-origin (allows frontend API calls)'],
        ['Cross-Origin-Embedder-Policy', 'credentialless'],
        ['Referrer-Policy', 'strict-origin-when-cross-origin'],
        ['X-DNS-Prefetch-Control', 'off'],
        ['X-Download-Options', 'noopen'],
        ['X-Permitted-Cross-Domain-Policies', 'none'],
        ['Origin-Agent-Cluster', 'enabled'],
        ['X-Powered-By', 'removed (Express fingerprint hidden)'],
    ]);

    drawSubTitle(doc, '3.3 Environment Behaviour');
    drawBulletList(doc, [
        'Development: HSTS disabled to avoid localhost HTTPS redirect issues.',
        'Development: CSP upgrade-insecure-requests disabled.',
        'Production: full HSTS with preload enabled.',
        'Production: CSP forces HTTPS upgrade via upgrade-insecure-requests.',
    ]);

    drawSubTitle(doc, '3.4 Files Modified / Added');
    drawBulletList(doc, [
        'backend/middleware/security.js — NEW: Helmet configuration',
        'backend/server.js — security middleware applied before CORS',
        'backend/package.json — helmet dependency added',
    ]);

    if (doc.y > 600) doc.addPage();

    drawSectionTitle(doc, '4. Required Environment Variables');
    drawTable(doc, ['Variable', 'Purpose', 'Example'], [
        ['MONGODB_URI', 'MongoDB connection string', 'mongodb://localhost:27017/invoPrint'],
        ['JWT_SECRET', 'JWT signing secret', 'your-secret-key'],
        ['JWT_EXPIRES_IN', 'Token/cookie expiry', '7d'],
        ['CLIENT_URL', 'Frontend origin for CORS & CSP', 'http://localhost:3001'],
        ['NODE_ENV', 'production enables HSTS & secure cookies', 'production'],
        ['PORT', 'API server port', '4000'],
    ]);

    drawSectionTitle(doc, '5. Testing Checklist');
    drawBulletList(doc, [
        'Restart backend and frontend after changes.',
        'Login and verify "token" cookie in DevTools → Application → Cookies.',
        'Confirm cookie has HttpOnly flag enabled.',
        'Refresh page and confirm user remains logged in.',
        'Logout and confirm cookie is removed.',
        'Inspect API response headers for CSP, nosniff, X-Frame-Options, etc.',
        'In production, verify HTTPS is used before enabling HSTS.',
    ]);

    drawSectionTitle(doc, '6. Notes for Deployment');
    drawBulletList(doc, [
        'Set NODE_ENV=production on the live server.',
        'Serve the application over HTTPS in production.',
        'Set CLIENT_URL to the exact production frontend URL.',
        'Existing users with old localStorage tokens must log in again.',
        'Bearer token in Authorization header is still supported for backward compatibility.',
    ]);

    doc.moveDown(1);
    doc.fillColor('#6b7280').fontSize(9).text(
        'Generated automatically for Invoice Printer | Security Updates Documentation | 2 July 2026',
        { align: 'center' }
    );

    doc.end();

    stream.on('finish', () => {
        console.log(`PDF created: ${OUTPUT_FILE}`);
    });
};

generate();
