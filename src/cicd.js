
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const spawn = require('child_process').spawn;
const crypto = require('crypto');
const path = require('path');
var fileExists = require('file-exists-promise');

var AppInfo = require('./classes/AppInfo');

var express = require('express'), router = express.Router();

var tmp = require('tmp');
var tmpDir = util.promisify(tmp.dir);

var fs = require('fs');
const readFileAsync = util.promisify(fs.readFile);

//**********************************************

var sockets = require('./sockets');

//**********************************************

var Config = require('./appConfig');
var config = Config.dataSet;

//**********************************************

var statuses = require('./statuses');

//**********************************************

var ConfigClass = require('./config/config');
var buildMessagesConfig = new ConfigClass();
buildMessagesConfig.loadConfig('buildMessages.json');
var buildMessages = buildMessagesConfig.dataSet;

//**********************************************

const IN_PROGRESS = 0, FAILED = 1, SUCCESSFUL = 2;

//**********************************************

router.get('/result/:appID/:commit', async (req, res) => {
  var id = req.params.appID;
  var commit = req.params.commit;

  if (buildMessages[id + commit] !== undefined) {
    var body = {info: buildMessages[id + commit]};

    if (req.session.username !== undefined)
      body.username = req.session.username;

    res.render('result', body);
  } else {
    res.send("No way");
  }
});

router.post('/login', function (req, res) {

  // you might like to do a database look-up or something more scalable here
  if (req.body.username && req.body.username === config.login.user && req.body.password && req.body.password === config.login.pass) {
    req.session.authenticated = true;
    req.session.username = req.body.username;
    res.redirect('/app/list');
  } else {
    res.redirect('/login');
  }

});

router.get('/login', async (req, res) => {
  res.render('login');
});

router.post('/build/:id/:branch', async (req, res) => {
  var appID = req.params.id;
  var branch = req.params.branch;

  if (config.repos[appID] !== undefined) {
    var appInfo = config.repos[appID];
    if (appInfo.clone_url !== undefined) {

      var input = new AppInfo(appInfo.name, appInfo.clone_url, branch, 'HEAD');
      input.appID = appID;

      res.json({message: 'Build starting for ' + appInfo.name + '-' + branch + '.'});
      build_event(input);

    } else {
      res.json({message: 'Clone URL missing from ' + appInfo.name + '.'});
    }
  } else {
    res.json({message: 'Build ID does not exist.'});
  }
});

async function build_event(appInfo) {
  await updateStatus(appInfo, "middle", "Cloning repository.");

  try {
    appInfo.setRepoDir(await cloneRepo(appInfo));
  } catch (error) {
    await updateStatus(appInfo, "failure", "Failed to clone.");
    console.log('----------------');
    console.log('Unable to clone repo: ' + appInfo.clone_url);
    console.log(error);
    console.log('----------------');
  }

  if (appInfo.repoDir !== undefined) {
    try {
      appInfo.setConfig(await addRepoSetup(appInfo));
    } catch (error) {
      console.log('----------------');
      console.log('No barryci.json file found in ' + appInfo.repo);
      console.log(error);
      console.log('----------------');
      configFound = false;
    }

    if (appInfo.config !== undefined) {
      if (appInfo.branch === appInfo.config.focusBranch || appInfo.config.focusBranch === undefined) {
        updateStatus(appInfo, "pending", "Building application");
        var result = await buildLocal(appInfo);
        updateStatus(appInfo, (result.status == SUCCESSFUL ? "success" : "failure"), result.stage + " " + (result.status == SUCCESSFUL ? "successful" : "failed") + '.');
      } else {
        console.log('Build for ' + appInfo.repo + ' not starting. Incorrect branch: ' + appInfo.eventBranch);
      }
    } else {
      await updateStatus(appInfo, "not-started", "Build cancelled: barryci.json missing.");
    }
  }

};

async function cloneRepo(appInfo) {
  var repoName = appInfo.repo_name;
  if (repoName.indexOf('/') >= 0)
    repoName = repoName.split('/')[1];

  console.log('Clone for ' + repoName + ' starting.');
  var repoDir = await tmpDir();

  var clone_string = 'git clone --depth=1 ';

  if (appInfo.branch !== undefined) 
    clone_string += '--single-branch -b ' + appInfo.branch + ' ';

  clone_string += appInfo.clone_url;

  try {
    var { stdout, stderr } = await exec(clone_string, { cwd: repoDir });
    repoDir = path.join(repoDir, repoName);
    
    console.log('Cloned ' + repoName + ': ' + repoDir);
    return Promise.resolve(repoDir);
    
  } catch (error) {
    console.log('Clone failed for ' + repoName + ': ');
    console.log(stderr);
    return Promise.reject(stderr);
  }
}

async function buildLocal(appInfo, appID) {
  
  var stage = '';
  var timers = [Date.now(), null];

  console.log('Build for ' + appInfo.repo_name + '-' + appInfo.branch + ' starting.');
  var messageResult = {
    project: appInfo.repo_name,
    status: IN_PROGRESS,
    branch: appInfo.branch,
    commit: appInfo.commit,
    timestamp: new Date().toLocaleString(),
    message: 'Building application branch ' + appInfo.branch + '.\n\r',
    panel: 'warning',
    time_length: 'In progress.'
  }

  var key = appInfo.repo_name + appInfo.commit;
  buildMessages[key] = messageResult;
  sockets.results.setStatus(appInfo.appID, appInfo.commit, messageResult.panel, 'In progress.');

  stage = 'Build';
  var command, stdout, stderr;
  try {
    sockets.results.setStandardContent(appInfo.appID, appInfo.commit, "Build starting...\n\r");

    if (appInfo.config.build !== undefined) { 
      if (appInfo.config.build.length > 0) {

        for (var i in appInfo.config.build) {
          command = appInfo.config.build[i];
          stdout = await execPromise(command.command, command.args || [], appInfo);
        }
        stderr = undefined; //No error?

      } else {
        stderr = '"build" flag in barryci.json is empty. Build failed as no commands provided.';
        sockets.results.setStandardContent(appID, commit, stderr);
      }
    }
  } catch (err) {
    stderr = err;
  }
  
  console.log('Build finished for ' + appInfo.repo_name + '-' + appInfo.branch + ': ' + (stderr ? "failed" : "successful"));

  if (typeof stderr === 'object') {
    stderr = stderr.message + '\n\r' + stderr.stack;
  }

  if (stderr) {
    messageResult.status = FAILED;
    messageResult.message = stderr;
    messageResult.panel = 'danger';
  } else {
    messageResult.status = SUCCESSFUL;
    if (config.store_stdout === true)
      messageResult.message = stdout;
    else
      messageResult.message = 'Build successful. Standout out removed.';
    messageResult.panel = 'success';
  }

  sockets.results.pushStandardContent(appInfo.appID, appInfo.commit, "End of build.\n\r");

  timers[1] = Date.now();

  var res = Math.abs(timers[0] - timers[1]) / 1000;
  var minutes = Math.floor(res / 60) % 60;
  var seconds = res % 60;
  messageResult.time_length = minutes + 'm ' + seconds + 's';

  sockets.results.setStatus(appInfo.appID, appInfo.commit, messageResult.panel, messageResult.time_length);

  console.log('Saving buildMessages.');

  buildMessages[key] = messageResult;
  try {
    await buildMessagesConfig.saveConfigAsync();
  } catch (e) {
    console.log('Couldn\'t save buildMessages.');
    console.log(e);
  }

  return Promise.resolve({
    stage: stage,
    status: messageResult.status
  });
}

async function updateStatus(appInfo, status, text) {
  var url = config.address + ':' + config.port + '/result/' + appInfo.repo_name + '/' + appInfo.commit
  var key = appInfo.appID + appInfo.branch;

  statuses[key] = {
    name: appInfo.repo_name,
    repo: appInfo.repo_name + '-' + appInfo.branch,
    commit: appInfo.commit,
    status: status,
    text: text,
    url: url,
    time: new Date().toLocaleString()
  };

  sockets.view.updateStatus(key, statuses[key]);
}

function execPromise(command, args, appInfo) {
  return new Promise((resolve, reject) => {
    var output = "";
    const child = spawn(command, args, {});

    var appID = appInfo.appID;
    var commit = appInfo.commit;

    child.stdout.on('data', (data) => {
      var content = data.toString('utf8');
      output += content;

      sockets.results.pushStandardContent(appID, commit, content);
    });

    child.stderr.on('data', (data) => {
      var content = data.toString('utf8');
      output += content;

      sockets.results.pushStandardContent(appID, commit, content);
    });

    child.on('error', (data) => {
      var message = (data.code + ' (' + data.errno + ') - ' + data.path + ': ' + data.message);
      output += message;

      sockets.results.pushStandardContent(appID, commit, '\n\r' + message + '\n\r');
    });

    child.on('close', (code) => {
      if (code !== 0) {
        if (output.length > 500)
          output = output.substr(output.length - 500);

        reject(output);
      } else {
        resolve(output);
      }
    });
  });
}

async function addRepoSetup(appInfo) {
  var contents = await readFileAsync(path.join(appInfo.repoDir, 'barryci.json'), 'utf8');

  contents = contents.replace(new RegExp('&branch-short', 'g'), (appInfo.branch > 3 ? appInfo.branch.substr(0, 3) : appInfo.branch));
  contents = contents.replace(new RegExp('&branch', 'g'), appInfo.branch);

  return JSON.parse(contents);
}

module.exports = router;