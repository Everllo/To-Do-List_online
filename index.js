const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { parse } = require('querystring');
const cookie = require('cookie');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { fork } = require('child_process');

const PORT = 3000;
const SESSION_SECRET = 'your-secret-key';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

// SQLite database setup
const db = new sqlite3.Database('./todolist.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        // Create tables if they don't exist
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                telegram_id TEXT,
                telegram_link_code TEXT
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                text TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )`);
        });
    }
});

const sessions = {};

// Helper functions for SQLite
function dbGet(query, params) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(query, params) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbRun(query, params) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

// Запускаем Telegram бота как дочерний процесс
const botProcess = fork(path.join(__dirname, 'bot.js'));

botProcess.on('error', (err) => {
    console.error('Failed to start bot process:', err);
});

botProcess.on('exit', (code, signal) => {
    if (code !== null) {
        console.error(`Bot process exited with code ${code}`);
    } else {
        console.error(`Bot process was killed with signal ${signal}`);
    }
});

console.log('Telegram bot process started');

// Helper functions
function generateSessionId() {
    return uuidv4();
}

function setSessionCookie(res, sessionId) {
    res.setHeader('Set-Cookie', cookie.serialize('sessionId', sessionId, {
        httpOnly: true,
        maxAge: SESSION_MAX_AGE,
        path: '/',
        sameSite: 'strict',
        secure: false
    }));
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', cookie.serialize('sessionId', '', {
        httpOnly: true,
        maxAge: 0,
        path: '/'
    }));
}

async function getUserFromSession(req) {
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionId = cookies.sessionId;
    
    if (!sessionId || !sessions[sessionId]) {
        return null;
    }
    
    const userId = sessions[sessionId].userId;
    if (!userId) return null;
    
    try {
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
        return user || null;
    } catch (error) {
        console.error('Database error:', error);
        return null;
    }
}

// Auth functions
async function registerUser(username, password) {
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const telegramLinkCode = uuidv4();
        const result = await dbRun(
            'INSERT INTO users (username, password, telegram_link_code) VALUES (?, ?, ?)',
            [username, hashedPassword, telegramLinkCode]
        );
        return { 
            insertId: result.lastID,
            telegramLinkCode 
        };
    } catch (error) {
        console.error('Registration error:', error);
        throw error;
    }
}

async function getTelegramLinkCode(userId) {
    try {
        const user = await dbGet(
            'SELECT telegram_link_code FROM users WHERE id = ?',
            [userId]
        );
        if (user && user.telegram_link_code) {
            return user.telegram_link_code;
        } else {
            // Generate new link code if none exists
            const newLinkCode = uuidv4();
            await dbRun(
                'UPDATE users SET telegram_link_code = ? WHERE id = ?',
                [newLinkCode, userId]
            );
            return newLinkCode;
        }
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function loginUser(username, password) {
    try {
        const user = await dbGet(
            'SELECT * FROM users WHERE username = ?',
            [username]
        );
        
        if (!user) {
            throw new Error('User not found');
        }
        
        const passwordMatch = await bcrypt.compare(password, user.password);
        
        if (!passwordMatch) {
            throw new Error('Invalid password');
        }
        
        return user;
    } catch (error) {
        console.error('Login error:', error);
        throw error;
    }
}

// Todo functions
async function retrieveListItems(userId) {
    try {
        return await dbAll(
            'SELECT id, text FROM items WHERE user_id = ? ORDER BY id',
            [userId]
        );
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function addListItem(userId, itemText) {
    try {
        const result = await dbRun(
            'INSERT INTO items (user_id, text) VALUES (?, ?)',
            [userId, itemText]
        );
        return result.lastID;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function updateListItem(userId, itemId, newText) {
    try {
        const result = await dbRun(
            'UPDATE items SET text = ? WHERE id = ? AND user_id = ?',
            [newText, itemId, userId]
        );
        return result.changes > 0;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function deleteListItem(userId, itemId) {
    try {
        const result = await dbRun(
            'DELETE FROM items WHERE id = ? AND user_id = ?',
            [itemId, userId]
        );
        return result.changes > 0;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}

async function getHtmlRows(userId) {
    try {
        const todoItems = await retrieveListItems(userId);
        return todoItems.map((item, index) => `
            <tr data-id="${item.id}">
                <td>${index + 1}</td>
                <td class="item-text">${item.text}</td>
                <td>
                    <button class="edit-btn">✏️</button>
                    <button class="delete-btn">×</button>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error generating HTML:', error);
        return '<tr><td colspan="3">Error loading items</td></tr>';
    }
}

async function serveLoginPage(res, error = null) {
    try {
        let html = await fs.promises.readFile(
            path.join(__dirname, 'login.html'), 
            'utf8'
        );
        
        if (error) {
            html = html.replace('{{error}}', `<div class="error">${error}</div>`);
        } else {
            html = html.replace('{{error}}', '');
        }
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    } catch (error) {
        console.error('Error serving login page:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
    }
}

async function serveTodoPage(res, userId) {
    try {
        let html = await fs.promises.readFile(
            path.join(__dirname, 'todo.html'), 
            'utf8'
        );
        const processedHtml = html.replace('{{rows}}', await getHtmlRows(userId));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(processedHtml);
    } catch (error) {
        console.error('Error serving todo page:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
    }
}

async function handleRequest(req, res) {
    try {
        // Static files
        if (req.url === '/style.css' && req.method === 'GET') {
            const css = await fs.promises.readFile(path.join(__dirname, 'style.css'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end(css);
            return;
        }

        // Auth routes
        if (req.url === '/register' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const { username, password } = JSON.parse(body);
                    if (!username?.trim() || !password?.trim()) {
                        throw new Error('Username and password are required');
                    }
                    
                    await registerUser(username.trim(), password.trim());
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    console.error('Registration error:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        error: error.message 
                    }));
                }
            });
            return;
        }

        if (req.url === '/login' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const { username, password } = JSON.parse(body);
                    if (!username?.trim() || !password?.trim()) {
                        throw new Error('Username and password are required');
                    }
                    
                    const user = await loginUser(username.trim(), password.trim());
                    const sessionId = generateSessionId();
                    sessions[sessionId] = { userId: user.id };
                    
                    setSessionCookie(res, sessionId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    console.error('Login error:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        error: error.message 
                    }));
                }
            });
            return;
        }

        if (req.url === '/logout' && req.method === 'POST') {
            const cookies = cookie.parse(req.headers.cookie || '');
            const sessionId = cookies.sessionId;
            
            if (sessionId && sessions[sessionId]) {
                delete sessions[sessionId];
            }
            
            clearSessionCookie(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        // Check authentication for todo routes
        const user = await getUserFromSession(req);

        if (req.url === '/' && req.method === 'GET') {
            if (!user) {
                await serveLoginPage(res);
            } else {
                await serveTodoPage(res, user.id);
            }
            return;
        }

        if (!user) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }

        // Todo routes
        if (req.url === '/add' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const { text } = JSON.parse(body);
                    if (!text?.trim()) {
                        throw new Error('Invalid input');
                    }
                    await addListItem(user.id, text.trim());
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    console.error('Add error:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        error: error.message 
                    }));
                }
            });
            return;
        }

        if (req.url === '/update' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const { id, text } = JSON.parse(body);
                    if (!id || isNaN(id) || !text?.trim()) {
                        throw new Error('Invalid input');
                    }
                    const success = await updateListItem(user.id, id, text.trim());
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success }));
                } catch (error) {
                    console.error('Update error:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        error: error.message 
                    }));
                }
            });
            return;
        }

        if (req.url === '/delete' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const { id } = JSON.parse(body);
                    if (!id || isNaN(id)) {
                        throw new Error('Invalid ID');
                    }
                    const success = await deleteListItem(user.id, id);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success }));
                } catch (error) {
                    console.error('Delete error:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        error: error.message 
                    }));
                }
            });
            return;
        }

        if (req.url === '/telegram-link-code' && req.method === 'GET') {
            try {
                const linkCode = await getTelegramLinkCode(user.id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, linkCode }));
            } catch (error) {
                console.error('Telegram link error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
            }
            return;
        }

        // Not found
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    } catch (error) {
        console.error('Server error:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
    }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    botProcess.kill();
    server.close(() => {
        db.close();
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    botProcess.kill();
    server.close(() => {
        db.close();
        console.log('Server closed');
        process.exit(0);
    });
});