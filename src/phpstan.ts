import { ICheckResult, handleDiagnosticErrors } from "./utils";
import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";
import { workspace, window, TextDocument, languages, DiagnosticCollection } from "vscode";
import { createHash } from "crypto";

interface IResultData
{
    hash: string;
    results: ICheckResult[]
}

interface IExtensionConfig
{
    path: string | null;
    level: string;
    memoryLimit: string;
    options: string[],
    enabled: boolean
}    

export class PHPStan
{
    private _current: { [key: string]: child_process.ChildProcess };
    private _results: { [key: string]: IResultData };
    private _filename: string;
    private _binaryPath: string | null;
    private _level: string;
    private _memoryLimit: string;
    private _customOptions: string[];
    private _enabled: boolean;
    private _diagnosticCollection: DiagnosticCollection;

    constructor(config: IExtensionConfig)
    {
        this._current = {};
        this._results = {};
        this._filename = null;
        this._binaryPath = config.path;
        this._level = config.level;
        this._memoryLimit = config.memoryLimit;
        this._customOptions = config.options;
        this._enabled = config.enabled;
        this._diagnosticCollection = languages.createDiagnosticCollection("error");

        if (this._binaryPath !== null && !fs.existsSync(this._binaryPath)) {
            window.showErrorMessage("Failed to find phpstan, the given path doesn't exist.");

            this._binaryPath = null;
        } else {
            if (this._binaryPath === null) {
                this.findPHPStan();
            }

            if (this._enabled) {
                if (this._binaryPath === null) {
                    window.showErrorMessage("Failed to find phpstan, phpstan will be disabled for this session.");
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
        if (this._binaryPath === null || !this._enabled) {
            return;
        }

        if (doc.languageId !== "php") {
            return;
        }

        if (this._current[doc.fileName] !== undefined) {
            this._current[doc.fileName].kill();
            delete this._current[doc.fileName];
        }

        let hash = createHash("sha1").update(fs.readFileSync(doc.fileName)).digest("hex");
        if (this._results[doc.fileName] !== undefined) {
            if (this._results[doc.fileName].hash === hash) {
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

        let autoload = "";

        const workspacefolder = workspace.getWorkspaceFolder(doc.uri).uri.fsPath;
        const autoloadfile = path.join(workspacefolder, "vendor/autoload.php");

        if (fs.existsSync(autoloadfile)) {
            autoload = `--autoload-file=${autoloadfile}`;
        }

        this._current[doc.fileName] = child_process.spawn(this._binaryPath, [
            "analyse",
            `--level=${this._level}`,
            autoload,
            "--errorFormat=raw",
            `--memory-limit=${this._memoryLimit}`,
            ...this._customOptions,
            doc.fileName
        ]);
        this._filename = doc.fileName;

        let results: string = "";
        this._current[doc.fileName].stdout.on('data', (data) => {
            if (data instanceof Buffer) {
                data = data.toString("utf8");
            }

            results += data;
        });

        this._current[doc.fileName].on("error", (err) => {
            if (err.message.indexOf("ENOENT") !== -1) {
                window.showErrorMessage("Failed to find phpstan, the given path doesn't exist.");

                this._binaryPath = null;
            }
        });

        this._current[doc.fileName].on('exit', (code) => {
            if (code !== 1) {
                delete this._current[doc.fileName];
                return;
            }

            const data: ICheckResult[] = results
                .split("\n")
                .map(x => x.substr(doc.fileName.length + 1).trim())
                .filter(x => x.length > 0)
                .map(x => x.split(":"))
                .map(x => {
                    const line = Number(x[0]);
                    x.shift();

                    const error = x.join(":");
                    return {
                        file: doc.fileName,
                        line: line,
                        msg: error
                    };
                })
                .filter(x => !isNaN(x.line));

            this._results[doc.fileName] = {
                hash: hash,
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
        });
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

    get diagnosticCollection()
    {
        return this._diagnosticCollection;
    }

    set enabled(val: boolean)
    {
        this._enabled = val;

        if (this._enabled) {
            if (this._binaryPath === null) {
                window.showErrorMessage("Failed to find phpstan, phpstan will be disabled for this session.");
            }
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
            window.showErrorMessage("Failed to find phpstan, phpstan will be disabled.");
        }

        if (val !== null && !fs.existsSync(this._binaryPath)) {
            window.showErrorMessage("Failed to find phpstan, the given path doesn't exist.");

            this._binaryPath = null;
        }
    }

    set level(val: string)
    {
        this._level = val;

        // Reset in-memory cached results
        this._results = {};
    }

    set memoryLimit(val: string)
    {
        this._memoryLimit = val;
    }

    set options(val: string[])
    {
        this._customOptions = val;

        // Reset in-memory cached results
        this._results = {};
    }
}