const fs = require('fs');
const readline = require('readline');
const playwright = require('playwright');
const pbf = require('pbf');
const botbuilder = require('botbuilder');
const botkit = require('botkit');
const { selectors, chatType } = require('./constants.js');
const { TrovoMessage } = require('./trovoproto.js');
require('dotenv').config();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

class TrovoAdapter extends botbuilder.BotAdapter {
    name = 'Trovo Adapter';
    version = require('../package.json').version;
    botkit_worker = botkit.BotWorker;

    constructor() {
        super();
        this._options = {
            headless: process.env.HEADLESS === 'true',
            speedUp: process.env.SPEEDUP === 'true'
        };
    }

    init(controller) {
        this._controller = controller;
        this._options.userAgent =
            `${process.env.BOTNAME}/${this.version}`;
        controller.ready(async() => {
            await this._login();
            await this._joinChat();
            await this._isLoggedIn();
            await this._enableNetworkSession();
        });
    }

    async _login() {
        this._browser = await playwright.chromium.launch({
            headless: this._options.headless
        });
        this._context = await this._browser.newContext({
            userAgent: this._options.userAgent
        });
        await this._addCookie();
        this._page = await this._context.newPage();
        if (this._options.speedUp === true) {
            this._speedUp();
        }
        this.url = new URL('https://trovo.live/?openLogin=1');
        if (this._cookie.length === 0) {
            await this._loginWithoutCookie();
            await this._checkSelector(selectors.verificationButton);
            await this._saveCookie();
        }
    }

    async _addCookie() {
        this._cookie = [];
        try {
            this._cookie = require(`${require.main.path}/storage/${
                process.env.BOTNAME}-cookies.json`);
            await this._context.addCookies(this._cookie);
            console.info('Cookie loaded');
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') {
                console.error('_addCookie:', e);
            }
        }
    }

    _speedUp() {
        console.info('Speed up is enabled')
        this._page.route('*', route => {
            let checkthisUrl = route.request().url();
            let allowList = [
                'https://gql.trovo.live/',
                'https://static.trovo.live/',
                'https://trovo.live/',
                'https://web-msdkpass.trovo.live/'
            ];
            route[allowList.find(url => checkthisUrl.startswith(url)) ===
                undefined ? 'abort' : 'continue']();
        });
    }

    async _loginWithoutCookie() {
        console.info('Logging into',
            this.url.href, 'for', process.env.BOTNAME);
        try {
            await this._page.goto(this.url.href);
            await this._page.fill(selectors.loginInput, process.env.LOGIN);
            await this._page.fill(selectors.passwordInput,
                process.env.PASSWORD);
            await this._page.keyboard.press('Enter');
            try {
                await this._page.waitForNavigation();
            } catch (e) {
                if (e instanceof playwright.errors.TimeoutError === false) {
                    console.error('_loginWithoutCookie:waitFor:', e);
                }
            }
        } catch (e) {
            if (e instanceof playwright.errors.TimeoutError) {
                console.error('Navigation Error: We had trouble reaching', url,
                    'Please check your internet connection and restart bot');
                this._shutdown();
            }
            console.error('_loginWithoutCookie:', e);
        }
    }

    async _checkSelector(selector) {
        try {
            await this._page.waitForSelector(selector, { timeout: 10000 });
            await this._page.dispatchEvent(selector, 'click');
            if (selector === selectors.verificationButton) {
                this._verificationProcess();
            }
        } catch (e) {
            if (e instanceof playwright.errors.TimeoutError === false) {
                console.error(`_checkSelector:${selector}:`, e);
            }
        }
    }

    async _verificationProcess() {
        try {
            await this._page.waitForSelector(selectors.verificationInput);
            const verificationEmail =
                await this._page.$(selectors.verificationEmail);
            console.info('Please check:',
                await verificationEmail.textContent(),
                'for verification code.');
            rl.question('Enter your verification code: ', async(code) => {
                await this._page.dispatchEvent(selectors.verificationInput,
                    'click');
                await this._page.keyboard.type(code);
            });
            await this._page.waitForNavigation({ timeout: 300000 });
        } catch (e) {
            if (e instanceof playwright.errors.TimeoutError) {
                console.error('You did not verify in time. Please restart');
                await this._shutdown();
            }
        }
    }

    async _shutdown() {
        await this._browser.close();
        process.exit(0);
    }

    async _saveCookie() {
        let saveCookie = false;
        const cookies = await this._context.cookies();
        cookies.forEach(cookie => {
            if (cookie.name === 'token') {
                saveCookie = true;
            }
            cookie.expires = 2147483647;
        });
        if (saveCookie) {
            fs.mkdir('./storage', err => {
                if (err) {
                    if (err.code !== 'EEXIST') {
                        throw err;
                    }
                }
                fs.writeFile(`./storage/${process.env.BOTNAME}-cookies.json`,
                    JSON.stringify(cookies), err => {
                        if (err) {
                            console.error('_saveCookie:writeFile:', err);
                        }
                        console.info('Cookie has been saved');
                    });
            });
        } else {
            console.error('Cookie was not saved. Your username or password',
                'may have been incorrect. Please check your .env file.');
            await this._shutdown();
        }
    }

    async _joinChat() {
        this.url.searchParams.delete('openLogin');
        this.url.pathname = `/chat/${process.env.CHANNEL}`;
        console.info('Joining', this.url.href);
        try {
            await this._page.goto(this.url.href);
            await this._checkSelector(selectors.rulesButton);
            await this._checkSelector(selectors.followButton);
        } catch (e) {
            console.error('_joinChat:', e);
        }
    }

    async _isLoggedIn() {
        console.info('Checking to see if we logged in correctly');
        try {
            await this._page.dispatchEvent(selectors.onlineUsers, 'click');
            await this._page.waitForSelector(`"${process.env.BOTNAME}"`);
            await this._page.dispatchEvent(selectors.closeOnlineUsers,
                'click');
            console.info(process.env.BOTNAME, 'is logged in and ready');
        } catch (e) {
            if (e instanceof playwright.errors.TimeoutError) {
                console.error('The bot may not be logged in correctly.',
                    'Restart the bot if you have trouble with it responding.');
            } else {
                console.error('_isLoggedIn', e);
            }
        }
    }

    async _enableNetworkSession() {
        this._session = await this._context.newCDPSession(this._page);
        this._session.on('Network.webSocketFrameReceived',
            ({ requestId, timestamp, response }) => this._handle(
                response.opcode === 1 ? 'text' : 'binary',
                response.payloadData)
        );
        this._session.send('Network.enable');
    }

    _handle(payloadType, payload) {
        if (payloadType === 'text') {
            return;
        }
        const buffer = Buffer.from(payload, 'base64');
        const opcode = buffer.readUInt16BE(8);
        if (opcode !== 3) {
            return;
        }
        const frame = {
            totalLength: buffer.readUInt32BE(0),
            dataLength: buffer.readUInt32BE(18),
            get data() {
                return buffer.slice(this.totalLength - this.dataLength);
            }
        }
        this._messageToActivity(frame.data);
    }

    _messageToActivity(buffer) {
        const chat = TrovoMessage.read(new pbf(buffer)).chat;
        if (chat === null || chat.channelData.details.__history__ ||
            chat.channelData.displayName === process.env.BOTNAME) {
            return;
        }
        this.processActivity(chat);
    }

    async processActivity(activity) {
        const context = new botbuilder.TurnContext(this, activity);
        await this.runMiddleware(context,
            this._controller.handleTurn.bind(this._controller, context));
    }

    async sendActivities(context, activities) {
        for (let i = 0; i < activities.length; ++i) {
            const activity = activities[i];
            await this._page.fill(selectors.chatInput, activity.text);
            await this._page.keyboard.press('Enter');
        }
    }

    getPage() {
        return this._page;
    }
}

exports.TrovoAdapter = TrovoAdapter;