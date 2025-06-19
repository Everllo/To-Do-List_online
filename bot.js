const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

// SQLite database setup
const db = new sqlite3.Database('./todolist.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    }
});

const TELEGRAM_TOKEN = '8044718684:AAFuJX0cO9AFF0eEJdd8IKa2wsAkOi0A44Q';
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const userStates = {};

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

// Команда /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = await getUserIdByTelegramId(chatId);
    
    if (userId) {
        bot.sendMessage(chatId, 'Добро пожаловать в ваш To-Do List! Используйте команды:\n' +
            '/list - Показать все задачи\n' +
            '/add - Добавить новую задачу\n' +
            '/edit - Редактировать задачу\n' +
            '/delete - Удалить задачу');
    } else {
        bot.sendMessage(chatId, 'Пожалуйста, сначала войдите в систему на сайте и привяжите ваш Telegram аккаунт.');
    }
});

// Привязка Telegram аккаунта
bot.onText(/\/link (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const linkCode = match[1];
    
    try {
        const user = await dbGet(
            'SELECT id FROM users WHERE telegram_link_code = ?',
            [linkCode]
        );
        
        if (user) {
            await dbRun(
                'UPDATE users SET telegram_id = ?, telegram_link_code = NULL WHERE id = ?',
                [chatId, user.id]
            );
            bot.sendMessage(chatId, 'Ваш Telegram аккаунт успешно привязан! Теперь вы можете управлять задачами через бота.');
        } else {
            bot.sendMessage(chatId, 'Неверный код привязки. Пожалуйста, получите новый код на сайте.');
        }
    } catch (error) {
        console.error('Link error:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при привязке аккаунта.');
    }
});

// Показать список задач
bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = await getUserIdByTelegramId(chatId);
    
    if (!userId) {
        bot.sendMessage(chatId, 'Пожалуйста, сначала привяжите ваш Telegram аккаунт с помощью команды /link.');
        return;
    }
    
    try {
        const tasks = await getTasks(userId);
        if (tasks.length === 0) {
            bot.sendMessage(chatId, 'У вас пока нет задач.');
            return;
        }
        
        const taskList = tasks.map((task, index) => 
            `${index + 1}. ${task.text} (ID: ${task.id})`
        ).join('\n');
        
        bot.sendMessage(chatId, `Ваши задачи:\n${taskList}`);
    } catch (error) {
        console.error('List error:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при получении списка задач.');
    }
});

// Добавить задачу
bot.onText(/\/add/, (msg) => {
    const chatId = msg.chat.id;
    userStates[chatId] = { action: 'awaiting_task_text' };
    bot.sendMessage(chatId, 'Пожалуйста, введите текст новой задачи:');
});

// Редактировать задачу
bot.onText(/\/edit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = await getUserIdByTelegramId(chatId);
    
    if (!userId) {
        bot.sendMessage(chatId, 'Пожалуйста, сначала привяжите ваш Telegram аккаунт с помощью команды /link.');
        return;
    }
    
    try {
        const tasks = await getTasks(userId);
        if (tasks.length === 0) {
            bot.sendMessage(chatId, 'У вас пока нет задач для редактирования.');
            return;
        }
        
        userStates[chatId] = { 
            action: 'awaiting_task_selection_for_edit',
            tasks: tasks 
        };
        
        const taskList = tasks.map((task, index) => 
            `${index + 1}. ${task.text} (ID: ${task.id})`
        ).join('\n');
        
        bot.sendMessage(chatId, `Выберите задачу для редактирования (введите номер):\n${taskList}`);
    } catch (error) {
        console.error('Edit error:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при подготовке к редактированию задачи.');
    }
});

// Удалить задачу
bot.onText(/\/delete/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = await getUserIdByTelegramId(chatId);
    
    if (!userId) {
        bot.sendMessage(chatId, 'Пожалуйста, сначала привяжите ваш Telegram аккаунт с помощью команды /link.');
        return;
    }
    
    try {
        const tasks = await getTasks(userId);
        if (tasks.length === 0) {
            bot.sendMessage(chatId, 'У вас пока нет задач для удаления.');
            return;
        }
        
        userStates[chatId] = { 
            action: 'awaiting_task_selection_for_delete',
            tasks: tasks 
        };
        
        const taskList = tasks.map((task, index) => 
            `${index + 1}. ${task.text} (ID: ${task.id})`
        ).join('\n');
        
        bot.sendMessage(chatId, `Выберите задачу для удаления (введите номер):\n${taskList}`);
    } catch (error) {
        console.error('Delete error:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при подготовке к удалению задачи.');
    }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
    if (!msg.text) return;
    
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const userId = await getUserIdByTelegramId(chatId);
    
    // Пропускаем команды, начинающиеся с /
    if (text.startsWith('/')) {
        return;
    }
    
    if (!userId || !userStates[chatId]) return;
    
    const state = userStates[chatId];
    
    try {
        if (state.action === 'awaiting_task_text') {
            if (text.length === 0) {
                bot.sendMessage(chatId, 'Текст задачи не может быть пустым. Пожалуйста, введите текст задачи:');
                return;
            }
            
            await addTask(userId, text);
            delete userStates[chatId];
            bot.sendMessage(chatId, 'Задача успешно добавлена!');
        } 
        else if (state.action === 'awaiting_task_selection_for_edit') {
            const taskNum = parseInt(text);
            if (isNaN(taskNum)) {
                bot.sendMessage(chatId, 'Пожалуйста, введите номер задачи.');
                return;
            }
            
            if (taskNum < 1 || taskNum > state.tasks.length) {
                bot.sendMessage(chatId, 'Неверный номер задачи. Пожалуйста, попробуйте снова.');
                return;
            }
            
            const task = state.tasks[taskNum - 1];
            userStates[chatId] = { 
                action: 'awaiting_new_task_text',
                taskId: task.id 
            };
            
            bot.sendMessage(chatId, `Введите новый текст для задачи "${task.text}":`);
        } 
        else if (state.action === 'awaiting_new_task_text') {
            if (text.length === 0) {
                bot.sendMessage(chatId, 'Текст задачи не может быть пустым. Пожалуйста, введите новый текст задачи:');
                return;
            }
            
            await updateTask(userId, state.taskId, text);
            delete userStates[chatId];
            bot.sendMessage(chatId, 'Задача успешно обновлена!');
        } 
        else if (state.action === 'awaiting_task_selection_for_delete') {
            const taskNum = parseInt(text);
            if (isNaN(taskNum)) {
                bot.sendMessage(chatId, 'Пожалуйста, введите номер задачи.');
                return;
            }
            
            if (taskNum < 1 || taskNum > state.tasks.length) {
                bot.sendMessage(chatId, 'Неверный номер задачи. Пожалуйста, попробуйте снова.');
                return;
            }
            
            const taskId = state.tasks[taskNum - 1].id;
            await deleteTask(userId, taskId);
            delete userStates[chatId];
            bot.sendMessage(chatId, 'Задача успешно удалена!');
        }
    } catch (error) {
        console.error('Action error:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при выполнении операции.');
        delete userStates[chatId];
    }
});

// Вспомогательные функции
async function getUserIdByTelegramId(telegramId) {
    try {
        const user = await dbGet(
            'SELECT id FROM users WHERE telegram_id = ?',
            [telegramId]
        );
        return user ? user.id : null;
    } catch (error) {
        console.error('Get user ID error:', error);
        return null;
    }
}

async function getTasks(userId) {
    return await dbAll(
        'SELECT id, text FROM items WHERE user_id = ? ORDER BY id',
        [userId]
    );
}

async function addTask(userId, text) {
    await dbRun(
        'INSERT INTO items (user_id, text) VALUES (?, ?)',
        [userId, text]
    );
}

async function updateTask(userId, taskId, newText) {
    await dbRun(
        'UPDATE items SET text = ? WHERE id = ? AND user_id = ?',
        [newText, taskId, userId]
    );
}

async function deleteTask(userId, taskId) {
    await dbRun(
        'DELETE FROM items WHERE id = ? AND user_id = ?',
        [taskId, userId]
    );
}

console.log('Telegram bot is running...');