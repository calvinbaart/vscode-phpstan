import { window, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem, TextDocument, TextEditorDecorationType, DiagnosticSeverity, Diagnostic, Uri, Range, DiagnosticCollection, languages, workspace, TextEditor } from 'vscode';
import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { readFileSync, exists, existsSync } from "fs";
import { createHash } from 'crypto';
import { platform } from 'os';

export let diagnosticCollection: DiagnosticCollection;

export function activate(context: ExtensionContext)
{
    let phpstan = new PHPStan();
    let controller = new PHPStanController(phpstan);
    diagnosticCollection = languages.createDiagnosticCollection("error");

    context.subscriptions.push(controller);
    context.subscriptions.push(phpstan);
    context.subscriptions.push(diagnosticCollection);
}

export interface ICheckResult {
    file: string;
    line: number;
    msg: string;
}

export function handleDiagnosticErrors(document: TextDocument[], errors: ICheckResult[])
{
    diagnosticCollection.clear();
    
    let diagnosticMap: Map<string, Diagnostic[]> = new Map();
    errors.forEach(error => {
        let canonicalFile = Uri.file(error.file).toString();
        let startColumn = 0;
        let endColumn = 1;
        
        for (const doc of document) {
            if (doc.uri.toString() === canonicalFile) {
                let range = new Range(error.line - 1, 0, error.line - 1, doc.lineAt(error.line - 1).range.end.character + 1);
                let text = doc.getText(range);
                let [_, leading, trailing] = /^(\s*).*(\s*)$/.exec(text);
                startColumn = leading.length;
                endColumn = text.length - trailing.length;
                break;
            }
        }
        
        let range = new Range(error.line - 1, startColumn, error.line - 1, endColumn);
        let diagnostic = new Diagnostic(range, error.msg, DiagnosticSeverity.Error);
        let diagnostics = diagnosticMap.get(canonicalFile);
        if (!diagnostics) {
            diagnostics = [];
        }
        diagnostics.push(diagnostic);
        diagnosticMap.set(canonicalFile, diagnostics);
    });

    diagnosticMap.forEach((diagMap, file) => {
        const fileUri = Uri.parse(file);
        const newErrors = diagMap;
        diagnosticCollection.set(fileUri, newErrors);
    });
};

interface IResultData
{
    hash: string;
    results: ICheckResult[]
};

class PHPStan
{
    private _current: {
        [key: string]: ChildProcess
    };
    private _results: {
        [key: string]: IResultData
    };
    private _filename: string;
    private _phpstanPath: string;

    constructor()
    {
        this._current = {};
        this._results = {};
        this._filename = null;
        this._phpstanPath = "";

        const vendor = "vendor/bin/phpstan" + (process.platform === "win32" ? ".bat" : "");
        const paths = [];

        for (const folder of workspace.workspaceFolders) {
            paths.push(join(folder.uri.fsPath, vendor));
        }

        if (process.env.COMPOSER_HOME !== undefined) {
            paths.push(join(process.env.COMPOSER_HOME, vendor));
        } else {
            if (process.platform === "win32") {
                paths.push(join(process.env.USERPROFILE, "AppData/Roaming/composer", vendor));
            } else {
                paths.push(join(process.env.HOME, ".composer", vendor))
            }
        }

        for (let path of paths) {
            if (existsSync(path)) {
                this._phpstanPath = path;
                break;
            }
        }

        if (this._phpstanPath.length === 0) {
            window.showErrorMessage("Failed to find phpstan, phpstan will be disabled for this session.");
        }
    }

    public updateDocument(doc: TextDocument) {
        if (this._phpstanPath.length === 0) {
            return;
        }

        if (doc.languageId !== "php") {
            return;
        }

        if (this._current[doc.fileName] !== undefined) {
            this._current[doc.fileName].kill();
            delete this._current[doc.fileName];
        }

        let hash = createHash("sha1").update(readFileSync(doc.fileName)).digest("hex");
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
                
                handleDiagnosticErrors(workspace.textDocuments, errors);
                return;
            }
        }

        let autoload = "";

        const workspacefolder = workspace.getWorkspaceFolder(doc.uri).uri.fsPath;
        const autoloadfile = join(workspacefolder, "vendor/autoload.php");

        if (existsSync(autoloadfile)) {
            autoload = "--autoload-file=" + autoloadfile;
        }

        this._current[doc.fileName] = spawn(this._phpstanPath, ["analyse", "-l", "4", autoload, "--errorFormat=raw", "--memory-limit=2048M", doc.fileName]);
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

            handleDiagnosticErrors(workspace.textDocuments, errors);
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
    }
}

class PHPStanController
{
    private _phpstan: PHPStan;
    private _disposable: Disposable;
    private _item;
 
    constructor(phpstan: PHPStan)
    {
        this._phpstan = phpstan;

        let subscriptions: Disposable[] = [];
        workspace.onDidSaveTextDocument(this._onDocumentEvent, this, subscriptions);
        workspace.onDidOpenTextDocument(this._onDocumentEvent, this, subscriptions);
        window.onDidChangeActiveTextEditor(this._onEditorEvent, this, subscriptions);

        // Get the current text editor
        let editor = window.activeTextEditor;
        if (editor) {
            this._phpstan.updateDocument(editor.document);
        }

        this._disposable = Disposable.from(...subscriptions);
    }

    dispose()
    {
        this._disposable.dispose();
    }

    private _onDocumentEvent(e: TextDocument)
    {
        this._phpstan.updateDocument(e);
    }

    private _onEditorEvent(e: TextEditor)
    {
        this._phpstan.updateDocument(e.document);
    }
}