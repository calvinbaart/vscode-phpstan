import { PHPStan } from "./phpstan";
import { Disposable, workspace, window, TextDocument, TextEditor } from "vscode";

export class PHPStanController
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

    private _onDocumentEvent(e: TextDocument)
    {
        this._phpstan.updateDocument(e);
    }

    private _onEditorEvent(e: TextEditor)
    {
        this._phpstan.updateDocument(e.document);
    }

    dispose()
    {
        this._disposable.dispose();
    }
}