const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { parse } = require('querystring');
const cookie = require('cookie');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { fork } = require('child_process');

const PORT = 3000;
const SESSION_SECRET = 'your-secret-key'; // Change this in production
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 1 week

// Database connection settings
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'QwErT-12345', // ← CHANGE THIS
    database: 'todolist',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);
const sessions = {};

// Запускаем Telegram бота как дочерний процесс
const botProcess = fork(path.join(__dirname, 'bot.js'));

// Обработка ошибок дочернего процесса
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
        secure: false // Set to true in production with HTTPS
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
    
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query('SELECT * FROM users WHERE id = ?', [userId]);
        return rows[0] || null;
    } catch (error) {
        console.error('Database error:', error);
        return null;
    } finally {
        if (connection) connection.release();
    }
}

// Auth functions
async function registerUser(username, password) {
    let connection;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const telegramLinkCode = uuidv4(); // Генерируем уникальный код для привязки Telegram
        connection = await pool.getConnection();
        const [result] = await connection.query(
            'INSERT INTO users (username, password, telegram_link_code) VALUES (?, ?, ?)',
            [username, hashedPassword, telegramLinkCode]
        );
        return { 
            insertId: result.insertId,
            telegramLinkCode 
        };
    } catch (error) {
        console.error('Registration error:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

async function getTelegramLinkCode(userId) {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query(
            'SELECT telegram_link_code FROM users WHERE id = ?',
            [userId]
        );
        return rows.length > 0 ? rows[0].telegram_link_code : null;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

async function loginUser(username, password) {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query(
            'SELECT * FROM users WHERE username = ?',
            [username]
        );
        
        if (rows.length === 0) {
            throw new Error('User not found');
        }
        
        const user = rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password);
        
        if (!passwordMatch) {
            throw new Error('Invalid password');
        }
        
        return user;
    } catch (error) {
        console.error('Login error:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

// Todo functions (updated to include user_id)
async function retrieveListItems(userId) {
    let connection;
    try {
        connection = await pool.getConnection();
        const query = 'SELECT id, text FROM items WHERE user_id = ? ORDER BY id';
        const [rows] = await connection.query(query, [userId]);
        return rows;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

async function addListItem(userId, itemText) {
    let connection;
    try {
        connection = await pool.getConnection();
        const query = 'INSERT INTO items (user_id, text) VALUES (?, ?)';
        const [result] = await connection.query(query, [userId, itemText]);
        return result.insertId;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

async function updateListItem(userId, itemId, newText) {
    let connection;
    try {
        connection = await pool.getConnection();
        const query = 'UPDATE items SET text = ? WHERE id = ? AND user_id = ?';
        const [result] = await connection.query(query, [newText, itemId, userId]);
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

async function deleteListItem(userId, itemId) {
    let connection;
    try {
        connection = await pool.getConnection();
        const query = 'DELETE FROM items WHERE id = ? AND user_id = ?';
        const [result] = await connection.query(query, [itemId, userId]);
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    } finally {
        if (connection) connection.release();
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
            const user = await getUserFromSession(req);
            if (!user) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                return;
            }

            try {
                const linkCode = await getTelegramLinkCode(user.id);
                if (!linkCode) {
                    // Если код не существует, генерируем новый
                    const newLinkCode = uuidv4();
                    const connection = await pool.getConnection();
                    await connection.query(
                        'UPDATE users SET telegram_link_code = ? WHERE id = ?',
                        [newLinkCode, user.id]
                    );
                    connection.release();
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, linkCode: newLinkCode }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, linkCode }));
                }
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
    console.log('MySQL config:', {
        ...dbConfig,
        password: '***'
    });
});

process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    botProcess.kill();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    botProcess.kill();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});