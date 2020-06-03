const path = require('path');
const {
	app,
	BrowserWindow,
	ipcMain,
	Tray,
	Menu,
	shell,
	dialog
} = require('electron');
const Startup = require('./utils/startupHandler');
const JsonDB = require('./utils/JsonDB');
const MBClient = require('./utils/MBClient');
const DiscordRPC = require('discord-rpc');
const UpdateChecker = require('./utils/UpdateChecker');
const Logger = require('./utils/logger');
const { calcEndTimestamp } = require('./utils/utils');
const { version, name, author, homepage } = require('./package.json');
const {
	clientIds,
	UUID,
	iconUrl,
	updateCheckInterval,
	logRetentionCount
} = require('./config/default.json');

const db = new JsonDB(path.join(app.getPath('userData'), 'config.json'));
const startupHandler = new Startup(app);
const checker = new UpdateChecker(author, name, version);

/**
 * @type {Logger}
 */
let logger;

/**
 * @type {BrowserWindow}
 */
let mainWindow;

/**
 * @type {Tray}
 */
let tray;

/**
 * @type {MBClient}
 */
let mbc;

/**
 * @type {DiscordRPC.Client}
 */
let rpc;

let presenceUpdate;

let updateChecker;

const startApp = () => {
	mainWindow = new BrowserWindow({
		width: 480,
		height: 310,
		minimizable: false,
		maximizable: false,
		webPreferences: {
			nodeIntegration: true
		},
		resizable: false,
		title: `Configure ${name}`
		// show: false
	});

	// only allow one instance
	const isLocked = app.requestSingleInstanceLock();
	if (!isLocked) app.quit();

	// is production?
	if (process.defaultApp) {
		mainWindow.resizable = true;
		mainWindow.maximizable = true;
		mainWindow.minimizable = true;
	} else {
		mainWindow.setMenu(null);
	}

	seedDB(); // perform migrations and fill in initial data

	logger = new Logger(
		process.defaultApp ? 'console' : 'file',
		app.getPath('userData'),
		logRetentionCount,
		db.data().logLevel
	);

	if (db.data().isConfigured) {
		moveToTray();
		startPresenceUpdater();
	} else {
		loadConfigurationPage();
	}

	// we invoke cheeckForUpdates immediately, so it will check at first application start
	updateChecker = setInterval(checkForUpdates(), updateCheckInterval);
};

const loadConfigurationPage = async () => {
	await mainWindow.loadFile(path.join(__dirname, 'static', 'configure.html'));
	mainWindow.webContents.send('config-type', db.data().serverType);

	mainWindow.show();

	appBarHide(false);
};

const resetApp = async () => {
	db.write({ isConfigured: false });

	stopPresenceUpdater();

	tray.destroy();

	loadConfigurationPage();
};

const toggleDisplay = () => {
	if (db.data().doDisplayStatus) {
		stopPresenceUpdater();
		db.write({ doDisplayStatus: false });
	} else {
		startPresenceUpdater();
		db.write({ doDisplayStatus: true });
	}
};

const checkForUpdates = (calledFromTray) => {
	checker.checkForUpdate((err, data) => {
		if (err) return logger.error(err);

		if (data.pending) {
			if (!calledFromTray) clearInterval(updateChecker);

			dialog.showMessageBox(
				{
					type: 'info',
					buttons: ['Okay', 'Get Latest Version'],
					message: 'A new version is available!',
					detail: `Your version is ${version}. The latest version currently available is ${data.version}`
				},
				(index) => {
					if (index === 1) {
						shell.openExternal(`${homepage}/releases/latest`);
					}
				}
			);
		} else if (calledFromTray) {
			dialog.showMessageBox({
				type: 'info',
				message: 'There are no new versions available to download'
			});
		}
	});

	// we return checkForUpdates because it takes in a function
	return checkForUpdates;
};

const appBarHide = (doHide) => {
	if (doHide) {
		if (process.platform === 'darwin') app.dock.hide();
	} else {
		if (process.platform === 'darwin') app.dock.show();
	}

	mainWindow.setSkipTaskbar(doHide);
};

const moveToTray = () => {
	tray = new Tray(path.join(__dirname, 'icons', 'tray.png'));

	const contextMenu = Menu.buildFromTemplate([
		{
			type: 'checkbox',
			label: 'Run at Startup',
			click: () => startupHandler.toggle(),
			checked: startupHandler.isEnabled
		},
		{
			type: 'checkbox',
			label: 'Display as Status',
			click: () => toggleDisplay(),
			checked: db.data().doDisplayStatus
		},
		{
			label: 'Ignored Libaries',
			click: () => ignoredLibrariesPrompt()
		},
		{
			type: 'separator'
		},
		{
			label: 'Check for Updates',
			click: () => checkForUpdates(true)
		},
		{
			label: 'Log Level',
			submenu: [
				{
					label: 'debug',
					click: () => setLogLevel('debug'),
					checked: isSetLogLevel('debug')
				},
				{
					label: 'info',
					click: () => setLogLevel('info'),
					checked: isSetLogLevel('info')
				},
				{
					label: 'warn',
					click: () => setLogLevel('warn'),
					checked: isSetLogLevel('warn')
				},
				{
					label: 'error',
					click: () => setLogLevel('error'),
					checked: isSetLogLevel('error')
				}
			]
		},
		{
			label: 'Show Logs',
			click: () => shell.openItem(logger.logPath)
		},
		{
			label: 'Reset App',
			click: () => resetApp()
		},
		{
			type: 'separator'
		},
		{
			label: 'Restart App',
			click: () => {
				app.quit();
				app.relaunch();
			}
		},
		{
			label: 'Quit',
			role: 'quit'
		}
	]);

	tray.setToolTip(name);
	tray.setContextMenu(contextMenu);

	mainWindow.hide();

	// ignore the promise
	// we dont care if the user interacts, we just want the app to start
	dialog.showMessageBox({
		type: 'info',
		title: name,
		message: `${name} has been minimized to the tray`
	});

	appBarHide(true);
};

const isSetLogLevel = (level) => db.data().logLevel === level;

const setLogLevel = (level) => {
	db.write({ logLevel: level });
	logger.logLevel = level;
};

const ignoredLibrariesPrompt = async () => {};

ipcMain.on('config-save', async (_, data) => {
	const emptyFields = Object.entries(data)
		.filter((entry) => !entry[1] && entry[0] !== 'password') // where entry[1] is the value, and if the field password is ignore it (emby and jelly dont require pws)
		.map((field) => field[0]); // we map empty fields by their names

	if (emptyFields.length) {
		mainWindow.webContents.send('validation-error', emptyFields);
		dialog.showErrorBox(
			name,
			'Please make sure that all the fields are filled in!'
		);
		return;
	}

	try {
		mbc = new MBClient(
			{
				address: data.serverAddress,
				username: data.username,
				password: data.password,
				protocol: data.protocol,
				port: data.port
			},
			{
				deviceName: name,
				deviceId: UUID,
				deviceVersion: version,
				iconUrl: iconUrl
			}
		);

		await mbc.login();

		db.write({ ...data, isConfigured: true, doDisplayStatus: true });

		moveToTray();
		startPresenceUpdater();
	} catch (error) {
		logger.error(error);
		dialog.showErrorBox(name, 'Invalid server address or login credentials');
	}
});

const stopPresenceUpdater = async () => {
	if (mbc) {
		await mbc.logout();
		mbc = null;
	}
	if (rpc) rpc.clearActivity();
	clearInterval(presenceUpdate);
};

const startPresenceUpdater = async () => {
	const data = db.data();

	if (!mbc) {
		mbc = new MBClient(
			{
				address: data.serverAddress,
				username: data.username,
				password: data.password,
				protocol: data.protocol,
				port: data.port
			},
			{
				deviceName: name,
				deviceId: UUID,
				deviceVersion: version,
				iconUrl: iconUrl
			}
		);
	}

	await mbc.login();

	await connectRPC();

	setPresence();
	presenceUpdate = setInterval(setPresence, 15000);

	try {
		await mbc.login();
	} catch (err) {
		logger.error(`Failed to authenticate: ${err}`);
	}
};

const setPresence = async () => {
	const data = db.data();

	try {
		let sessions;

		try {
			sessions = await mbc.getSessions();
		} catch (err) {
			return logger.error(`Failed to get sessions: ${err}`);
		}

		const session = sessions.filter(
			(session) =>
				session.UserName === data.username &&
				session.NowPlayingItem !== undefined
		)[0];

		if (session) {
			const currentEpochSeconds = new Date().getTime() / 1000;

			const endTimestamp = calcEndTimestamp(session, currentEpochSeconds);

			switch (session.NowPlayingItem.Type) {
				case 'Episode':
					// prettier-ignore
					const seasonNum = session.NowPlayingItem.ParentIndexNumber.padStart(2, '0');
					// prettier-ignore
					const episodeNum = session.NowPlayingItem.IndexNumber.padStart(2, '0');

					rpc.setActivity({
						details: `Watching ${session.NowPlayingItem.SeriesName}`,
						state: `${
							session.NowPlayingItem.ParentIndexNumber ? `S${seasonNum}` : ''
						}${session.NowPlayingItem.IndexNumber ? `E${episodeNum}: ` : ''}${
							session.NowPlayingItem.Name
						}`,
						largeImageKey: 'large',
						largeImageText: `Watching on ${session.Client}`,
						smallImageKey: session.PlayState.IsPaused ? 'pause' : 'play',
						smallImageText: session.PlayState.IsPaused ? 'Paused' : 'Playing',
						instance: false,
						endTimestamp: !session.PlayState.IsPaused && endTimestamp
					});
					break;
				case 'Movie':
					rpc.setActivity({
						details: 'Watching a Movie',
						state: session.NowPlayingItem.Name,
						largeImageKey: 'large',
						largeImageText: `Watching on ${session.Client}`,
						smallImageKey: session.PlayState.IsPaused ? 'pause' : 'play',
						smallImageText: session.PlayState.IsPaused ? 'Paused' : 'Playing',
						instance: false,
						endTimestamp: !session.PlayState.IsPaused && endTimestamp
					});
					break;
				case 'Audio':
					rpc.setActivity({
						details: `Listening to ${session.NowPlayingItem.Name}`,
						state: `By ${session.NowPlayingItem.AlbumArtist}`,
						largeImageKey: 'large',
						largeImageText: `Listening on ${session.Client}`,
						smallImageKey: session.PlayState.IsPaused ? 'pause' : 'play',
						smallImageText: session.PlayState.IsPaused ? 'Paused' : 'Playing',
						instance: false,
						endTimestamp: !session.PlayState.IsPaused && endTimestamp
					});
					break;
				default:
					rpc.setActivity({
						details: 'Watching Other Content',
						state: session.NowPlayingItem.Name,
						largeImageKey: 'large',
						largeImageText: `Watching on ${session.Client}`,
						smallImageKey: session.PlayState.IsPaused ? 'pause' : 'play',
						smallImageText: session.PlayState.IsPaused ? 'Paused' : 'Playing',
						instance: false,
						endTimestamp: !session.PlayState.IsPaused && endTimestamp
					});
			}
		} else {
			if (rpc) rpc.clearActivity();
		}
	} catch (error) {
		logger.error(`Failed to set activity: ${error}`);
	}
};

const connectRPC = () => {
	return new Promise((resolve) => {
		const data = db.data();

		rpc = new DiscordRPC.Client({ transport: 'ipc' });
		rpc
			.login({ clientId: clientIds[data.serverType] })
			.then(() => resolve())
			.catch(() => {
				logger.error(
					'Failed to connect to Discord. Attempting to reconnect in 30 seconds'
				);

				setTimeout(connectRPC, 30000);
			});

		rpc.transport.once('close', () => {
			rpc = null; // prevent cannot read property write of null errors

			logger.warn(
				'Discord RPC connection closed. Attempting to reconnect in 30 seconds'
			);

			setTimeout(connectRPC, 30000);
		});

		rpc.transport.once('open', () => {
			logger.info('Connected to Discord');
		});
	});
};

const seedDB = () => {
	// prettier-ignore
	if (db.data().doDisplayStatus === undefined) db.write({ doDisplayStatus: true }); // older releases wont have this , so enable by default
	if (!db.data().serverType) db.write({ serverType: 'emby' }); // we want emby by default
	if (!db.data().ignoredViews) db.write({ ignoredViews: [] });
	if (!db.data().logLevel) db.write({ logLevel: 'info' });
};

app.on('ready', () => startApp());
