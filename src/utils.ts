import { TextDocument, Diagnostic, Uri, Range, DiagnosticSeverity, DiagnosticCollection } from "vscode";

export interface ICheckResult {
    file: string;
    line: number;
    msg: string;
}

export function handleDiagnosticErrors(document: TextDocument[], errors: ICheckResult[], diagnosticCollection: DiagnosticCollection) {
    diagnosticCollection.clear();

    let diagnosticMap: Map<string, Diagnostic[]> = new Map();
    errors.forEach(error => {
        const canonicalFile = Uri.file(error.file).toString();
        const doc = document.find((item) => item.uri.toString() === canonicalFile);
        let startColumn = 0;
        let endColumn = 1;

        if (doc !== undefined) {
            let range = new Range(error.line - 1, 0, error.line - 1, doc.lineAt(error.line - 1).range.end.character + 1);
            let text = doc.getText(range);
            let [_, leading, trailing] = /^(\s*).*(\s*)$/.exec(text);
            startColumn = leading.length;
            endColumn = text.length - trailing.length;
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
