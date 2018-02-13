import { ICheckResult, handleDiagnosticErrors } from "./utils";
import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as tmp from "tmp";

import { workspace, window, TextDocument, languages, DiagnosticCollection, StatusBarItem, StatusBarAlignment } from "vscode";

interface IResultData
{
    version: number;
    results: ICheckResult[]
}

interface IExtensionConfig
{
    path: string | null;
    level: string;
    memoryLimit: string;
    options: string[],
    enabled: boolean,
    projectFile: string
}    

export class PHPStan
{
    private _current: { [key: string]: child_process.ChildProcess };
    private _results: { [key: string]: IResultData };
    private _timeouts: { [key: string]: NodeJS.Timer };

    private _binaryPath: string | null;
    private _config: IExtensionConfig;
    private _diagnosticCollection: DiagnosticCollection;
    private _statusBarItem: StatusBarItem;
    private _numActive: number;

    constructor(config: IExtensionConfig)
    {
        this._current = {};
        this._results = {};
        this._timeouts = {};
        this._binaryPath = config.path;
        this._config = config;
        this._diagnosticCollection = languages.createDiagnosticCollection("error");
        this._statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
        this._numActive = 0;

        if (this._binaryPath !== null && !fs.existsSync(this._binaryPath)) {
            window.showErrorMessage("[phpstan] Failed to find phpstan, the given path doesn't exist.");

            this._binaryPath = null;
        } else {
            if (this._binaryPath === null) {
                this.findPHPStan();
            }

            if (this._config.enabled) {
                if (this._binaryPath === null) {
                    window.showErrorMessage("[phpstan] Failed to find phpstan, phpstan will be disabled for this session.");
                }
            }
        }
    }

    public findPHPStan()
    {
        const vendor = "vendor/bin/phpstan" + (process.platform === "win32" ? ".bat" : "");
        const paths = [];

        for (const folder of workspace.workspaceFolders) {
            paths.push(path.join(folder.uri.fsPath, vendor));
        }

        if (process.env.COMPOSER_HOME !== undefined) {
            paths.push(path.join(process.env.COMPOSER_HOME, vendor));
        } else {
            if (process.platform === "win32") {
                paths.push(path.join(process.env.USERPROFILE, "AppData/Roaming/composer", vendor));
            } else {
                paths.push(path.join(process.env.HOME, ".composer", vendor))
            }
        }

        for (const path of paths) {
            if (fs.existsSync(path)) {
                this._binaryPath = path;
                break;
            }
        }
    }

    public updateDocument(doc: TextDocument)
    {
        if (this._binaryPath === null || !this._config.enabled) {
            this.hideStatusBar();
            return;
        }

        if (doc.languageId !== "php") {
            this.hideStatusBar();
            return;
        }

        if (this._current[doc.fileName] !== undefined) {
            this._current[doc.fileName].kill();
            delete this._current[doc.fileName];
        }

        if (this._results[doc.fileName] !== undefined) {
            if (this._results[doc.fileName].version === doc.version) {
                let errors = [...this._results[doc.fileName].results];

                for (let document of workspace.textDocuments) {
                    if (document.fileName === doc.fileName) {
                        continue;
                    }

                    if (this._results[document.fileName] !== undefined) {
                        errors = [...errors, ...this._results[document.fileName].results];
                    }
                }

                handleDiagnosticErrors(workspace.textDocuments, errors, this._diagnosticCollection);
                return;
            }
        }

        let autoload = [];
        let project = [];

        const workspaceFolder = workspace.getWorkspaceFolder(doc.uri);

        if (workspaceFolder) {
            const workspacefolderPath = workspaceFolder.uri.fsPath;
            const autoloadfile = path.join(workspacefolderPath, "vendor/autoload.php");

            if (fs.existsSync(autoloadfile)) {
                autoload.push(`--autoload-file=${autoloadfile}`);
            }
        }    

        if (this._config.projectFile !== null) {
            project.push("-c");
            project.push(this._config.projectFile);
        } else if (workspaceFolder) {
            const files = ["phpstan.neon", "phpstan.neon.dist"];

            for (const file of files) {
                if (fs.existsSync(path.join(workspaceFolder.uri.fsPath, file))) {
                    project.push("-c");
                    project.push(path.join(workspaceFolder.uri.fsPath, file));

                    break;
                }
            }
        }

        if (this._timeouts[doc.fileName] !== undefined) {
            clearTimeout(this._timeouts[doc.fileName]);
        }

        this._timeouts[doc.fileName] = setTimeout(() => {
            delete this._timeouts[doc.fileName];
            
            var tmpobj = tmp.fileSync();
            fs.writeSync(tmpobj.fd, doc.getText());

            this._current[doc.fileName] = child_process.spawn(this._binaryPath, [
                "analyse",
                `--level=${this._config.level}`,
                ...autoload,
                ...project,
                "--errorFormat=raw",
                `--memory-limit=${this._config.memoryLimit}`,
                ...this._config.options,
                tmpobj.name
            ]);

            let results: string = "";
            this._current[doc.fileName].stdout.on('data', (data) => {
                if (data instanceof Buffer) {
                    data = data.toString("utf8");
                }

                results += data;
            });

            this._current[doc.fileName].on("error", (err) => {
                if (err.message.indexOf("ENOENT") !== -1) {
                    window.showErrorMessage("[phpstan] Failed to find phpstan, the given path doesn't exist.");

                    this._binaryPath = null;
                }
            });

            this._statusBarItem.text = "[PHPStan] processing...";
            this._statusBarItem.show();

            this._numActive++;
            this._current[doc.fileName].on('exit', (code) => {
                this._numActive--;
                tmpobj.removeCallback();
            
                if (code !== 1) {
                    const data: any[] = results.split("\n")
                        .map(x => x.trim())
                        .filter(x => x.startsWith("Warning:") || x.startsWith("Fatal error:"))
                        .map(x => {
                            if (x.startsWith("Warning:")) {
                                const message = x.substr("Warning:".length).trim();

                                return {
                                    message,
                                    type: "warning"
                                };
                            }

                            const message = x.substr("Fatal error:".length).trim();
                            return {
                                message,
                                type: "error"
                            };
                        });
                
                    for (const error of data) {
                        switch (error.type) {
                            case "warning":
                                window.showWarningMessage(`[phpstan] ${error.message}`);
                                break;
                        
                            case "error":
                                window.showErrorMessage(`[phpstan] ${error.message}`);
                                break;
                        }
                    }

                    delete this._current[doc.fileName];
                    return;
                }

                const data: ICheckResult[] = results
                    .split("\n")
                    .map(x => x.substr(tmpobj.name.length + 1).trim())
                    .filter(x => x.length > 0)
                    .map(x => x.split(":"))
                    .map(x => {
                        let line = Number(x[0]);
                        x.shift();

                        // line 0 is not allowed so we need to start at 1
                        if (line === 0) {
                            line++;
                        }

                        const error = x.join(":");
                        return {
                            file: doc.fileName,
                            line: line,
                            msg: `[phpstan] ${error}`
                        };
                    })
                    .filter(x => !isNaN(x.line));

                this._results[doc.fileName] = {
                    version: doc.version,
                    results: data
                };

                let errors = data;
                for (let document of workspace.textDocuments) {
                    if (document.fileName === doc.fileName) {
                        continue;
                    }

                    if (this._results[document.fileName] !== undefined) {
                        errors = [...errors, ...this._results[document.fileName].results];
                    }
                }

                handleDiagnosticErrors(workspace.textDocuments, errors, this._diagnosticCollection);

                this.hideStatusBar();
            });
        }, 300);
    }

    dispose()
    {
        for (let key in this._current) {
            if (this._current[key].killed) {
                continue;
            }

            this._current[key].kill();
        }

        this._diagnosticCollection.dispose();
    }

    private hideStatusBar()
    {
        if (this._numActive === 0) {
            this._statusBarItem.hide();
        }
    }

    get diagnosticCollection()
    {
        return this._diagnosticCollection;
    }

    set enabled(val: boolean)
    {
        this._config.enabled = val;

        if (this._config.enabled) {
            if (this._binaryPath === null) {
                window.showErrorMessage("[phpstan] Failed to find phpstan, phpstan will be disabled for this session.");
            }
        } else {
            for (let key in this._current) {
                if (this._current[key].killed) {
                    continue;
                }

                this._current[key].kill();
            }

            this._current = {};
            this._numActive = 0;
            this.hideStatusBar();
        }
    }

    set path(val: string)
    {
        this._binaryPath = val;

        // Reset in-memory cached results
        this._results = {};

        if (this._binaryPath === null) {
            this.findPHPStan();
        }

        if (this._binaryPath === null) {
            window.showErrorMessage("[phpstan] Failed to find phpstan, phpstan will be disabled.");
        }

        if (val !== null && !fs.existsSync(this._binaryPath)) {
            window.showErrorMessage("[phpstan] Failed to find phpstan, the given path doesn't exist.");

            this._binaryPath = null;
        }
    }

    set level(val: string)
    {
        this._config.level = val;

        // Reset in-memory cached results
        this._results = {};
    }

    set memoryLimit(val: string)
    {
        this._config.memoryLimit = val;
    }

    set options(val: string[])
    {
        this._config.options = val;

        // Reset in-memory cached results
        this._results = {};
    }

    set projectFile(val: string)
    {
        this._config.projectFile = val;

        // Reset in-memory cached results
        this._results = {};
    }
}