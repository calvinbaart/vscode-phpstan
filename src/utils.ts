import { TextDocument, Diagnostic, Uri, Range, DiagnosticSeverity, DiagnosticCollection } from "vscode";
import * as glob from "glob";

export interface ICheckResult {
    file: string;
    line: number;
    msg: string;
    type?: DiagnosticSeverity;
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

        let severity = error.type === undefined ? DiagnosticSeverity.Error : error.type;
        let range = new Range(error.line - 1, startColumn, error.line - 1, endColumn);
        let diagnostic = new Diagnostic(range, error.msg, severity);
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

export function globAsync(pattern: string, options: glob.IOptions): Promise<string[]>
{
    return new Promise((resolve, reject) => {
        glob(pattern, options, (err, matches) => {
            if (err) {
                return reject(err);
            }

            resolve(matches);
        });
    });
}
