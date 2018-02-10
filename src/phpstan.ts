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

export class PHPStan
{
    private _current: { [key: string]: child_process.ChildProcess };
    private _results: { [key: string]: IResultData };
    private _filename: string;
    private _binaryPath: string;
    private _diagnosticCollection: DiagnosticCollection;

    constructor()
    {
        this._current = {};
        this._results = {};
        this._filename = null;
        this._binaryPath = "";
        this._diagnosticCollection = languages.createDiagnosticCollection("error");

        this.findPHPStan();

        if (this._binaryPath.length === 0) {
            window.showErrorMessage("Failed to find phpstan, phpstan will be disabled for this session.");
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
        if (this._binaryPath.length === 0) {
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
            autoload = "--autoload-file=" + autoloadfile;
        }

        this._current[doc.fileName] = child_process.spawn(this._binaryPath, ["analyse", "-l", "4", autoload, "--errorFormat=raw", "--memory-limit=2048M", doc.fileName]);
        this._filename = doc.fileName;

        let results: string = "";
        this._current[doc.fileName].stdout.on('data', (data) => {
            if (data instanceof Buffer) {
                data = data.toString("utf8");
            }

            results += data;
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
}