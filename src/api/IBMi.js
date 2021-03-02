const node_ssh = require(`node-ssh`);
const vscode = require(`vscode`);

module.exports = class IBMi {
  constructor() {
    this.client = new node_ssh.NodeSSH;
    this.currentHost = ``;
    this.currentPort = 22;
    this.currentUser = ``;
    this.tempRemoteFiles = {};
    this.defaultUserLibraries = [];

    /** @type {{[name: string]: string}} */
    this.remoteFeatures = {
      db2util: undefined,
      git: undefined
    };
    
    //Configration:
    this.homeDirectory = `.`;
    this.libraryList = [];
    this.tempLibrary = `ILEDITOR`;
    this.spfShortcuts = [`QSYSINC/H`];
    this.sourceASP = undefined;
    this.buildLibrary = `QTEMP`;

    //Global config
    this.logCompileOutput = false;
    this.autoRefresh = false;
  }

  /**
   * @param {{host: string, port: number, username: string, password: string, keepaliveInterval?: number}} connectionObject 
   * @returns {Promise<boolean>} Was succesful at connecting or not.
   */
  async connect(connectionObject) {
    try {
      connectionObject.keepaliveInterval = 35000;

      await this.client.connect(connectionObject);

      this.currentHost = connectionObject.host;
      this.currentPort = connectionObject.port;
      this.currentUser = connectionObject.username;

      await this.loadConfig();

      //Perhaps load in existing config if it exists here.

      //Continue with finding out info about system
      if (this.homeDirectory === `.`) await this.set(`homeDirectory`, `/home/${connectionObject.username}`);

      //Create home directory if it does not exist.
      try {
        await this.paseCommand(`mkdir ${this.homeDirectory}`);
      } catch (e) {
        //If the folder doesn't exist, then we need to reset the path
        //because we need a valid path for the home directory.
        if (e.indexOf(`File exists`) === -1) {
          //An error message here also?
          this.homeDirectory = `.`;
        }
      }

      //Since the compiles are stateless, then we have to set the library list each time we use the `SYSTEM` command
      //We setup the defaultUserLibraries here so we can remove them later on so the user can setup their own library list
      let currentLibrary = `QGPL`;
      this.defaultUserLibraries = [];
      let libraryListString = await this.qshCommand(`liblist`);
      if (typeof libraryListString === `string` && libraryListString !== ``) {
        const libraryList = libraryListString.split(`\n`);

        let lib, type;
        for (const line of libraryList) {
          lib = line.substr(0, 10).trim();
          type = line.substr(12);

          switch (type) {
            case `USR`:
              this.defaultUserLibraries.push(lib);
              break;
              
            case `CUR`:
              currentLibrary = lib;
              break;
          }
        }

        if (this.libraryList.length === 0) await this.set(`libraryList`, this.defaultUserLibraries);
      }

      //Next, we need to check the temp lib (where temp outfile data lives) exists
      try {
        await this.remoteCommand(
          `CRTLIB ` + this.tempLibrary,
          undefined,
        );
      } catch (e) {
        let [errorcode, errortext] = e.split(`:`);

        switch (errorcode) {
          case `CPF2111`: //Already exists, hopefully ok :)
            break;
          
          case `CPD0032`: //Can't use CRTLIB
            try {
              await this.remoteCommand(
                `CHKOBJ OBJ(QSYS/${this.tempLibrary}) OBJTYPE(*LIB)`,
                undefined
              );

              //We're all good if no errors
            } catch (e) {
              if (currentLibrary.startsWith(`Q`)) {
                //Temporary library not created. Some parts of the extension will not run without a temporary library.
              } else {
                this.tempLibrary = currentLibrary;
                //Using ${currentLibrary} as the temporary library for temporary data.
              }
            }
            break;
        }

        console.log(e);
      }

      //Next, we see what pase features are available (installed via yum)
      const packagesPath = `/QOpenSys/pkgs/bin/`;
      try {
        //This may enable certain features in the future.
        const call = await this.paseCommand(`ls -p ${packagesPath}`);
        if (typeof call === `string`) {
          const files = call.split(`\n`);
          for (const feature of Object.keys(this.remoteFeatures))
            if (files.includes(feature))
              this.remoteFeatures[feature] = packagesPath + feature;
        }
        
      } catch (e) {}

      return true;

    } catch (e) {
      return false;
    }
  }

  /**
   * Update connection settings
   * @param {string} string 
   * @param {any} value 
   */
  async set(string, value) {
    const globalData = vscode.workspace.getConfiguration(`code-for-ibmi`);
    let connections = globalData.get(`connectionSettings`);

    const index = connections.findIndex(conn => conn.host === this.currentHost);

    if (index >= 0) {
      connections[index][string] = value;
      this[string] = value;

      await globalData.update(`connectionSettings`, connections, vscode.ConfigurationTarget.Global);
    }
  }
  
  /**
   * Load configuration from vscode.
   */
  async loadConfig() {
    const globalData = vscode.workspace.getConfiguration(`code-for-ibmi`);

    let connections = globalData.get(`connectionSettings`);

    if (!connections.find(conn => conn.host === this.currentHost)) {
      //Defaults
      connections.push({
        "host": this.currentHost,
        "sourceFileList": [`QSYSINC/H`],
        "libraryList": `QSYS2,QSYSINC`,
        "homeDirectory": `homeDirectory`,
        "temporaryLibrary": `ILEDITOR`,
        "buildLibrary": `QTEMP`,
        "sourceASP": null
      });

      await globalData.update(`connectionSettings`, connections, vscode.ConfigurationTarget.Global);
    }

    let connectionConfig = connections.find(conn => conn.host === this.currentHost);

    //Connection settings
    this.spfShortcuts = connectionConfig[`sourceFileList`];
    this.libraryList = connectionConfig[`libraryList`].split(`,`).map(item => item.trim());
    this.homeDirectory = connectionConfig[`homeDirectory`];
    this.tempLibrary = connectionConfig[`temporaryLibrary`];
    this.sourceASP = (connectionConfig[`sourceASP`] ? connectionConfig[`sourceASP`] : undefined);

    //Editor settings
    this.logCompileOutput = globalData.get(`logCompileOutput`) || false;
    this.autoRefresh = globalData.get(`autoRefresh`);
  }

  /**
   * 
   * @param {string} command 
   * @param {string} [directory] If not passed, will use current home directory
   */
  remoteCommand(command, directory) {
    //execCommand does not crash..
    return this.paseCommand(`system "` + command + `"`, directory);
  }

  /**
   * 
   * @param {string|string[]} command 
   * @param {string} [directory] 
   * @param {number} [returnType] 
   */
  qshCommand(command, directory = this.homeDirectory, returnType = 0) {

    if (Array.isArray(command)) {
      command = command.join(`;`);
    }

    command = command.replace(/"/g, `\\"`);

    command = `echo "` + command + `" | /QOpenSys/usr/bin/qsh`;

    return this.paseCommand(command, directory, returnType);
  }

  /**
   * 
   * @param {string} command 
   * @param {null|string} [directory] If null/not passed, will default to home directory
   * @param {number} [returnType] If not passed, will default to 0. Accepts 0 or 1
   */
  async paseCommand(command, directory = this.homeDirectory, returnType = 0) {
    command = command.replace(/\$/g, `\\$`);

    let result = await this.client.execCommand(command, {
      cwd: directory,
    });

    if (returnType === 0) {
      if (result.code === 0 || result.code === null) return Promise.resolve(result.stdout);
      else return Promise.reject(result.stderr);
    } else {
      return Promise.resolve(result);
    }
  }

  /**
   * Generates path to a temp file on the IBM i
   * @param {string} key Key to the temp file to be re-used
   */
  getTempRemote(key) {

    if (this.tempRemoteFiles[key] !== undefined) {
      console.log(`Using existing temp: ` + this.tempRemoteFiles[key]);
      return this.tempRemoteFiles[key];
    } else {
      let value = `/tmp/vscodetemp-` + IBMi.makeid();
      console.log(`Using new temp: ` + value);
      this.tempRemoteFiles[key] = value;
      return value;
    }
  }

  static makeid() {
    let text = `o`;
    let possible =
      `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`;
  
    for (let i = 0; i < 9; i++)
      text += possible.charAt(Math.floor(Math.random() * possible.length));
  
    return text;
  }

  /**
   * Build the IFS path string to a member
   * @param {string|undefined} asp 
   * @param {string} lib 
   * @param {string} obj 
   * @param {string} mbr 
   */
  static qualifyPath(asp, lib, obj, mbr) {
    const path =
      (asp ? `/${asp}` : ``) + `/QSYS.lib/${lib}.lib/${obj}.file/${mbr}.mbr`;
    return path;
  }
}