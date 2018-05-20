import { ExtensionContext, workspace } from "vscode";
import { PHPStan } from "./phpstan";
import { PHPStanController } from "./controller";

export function activate(context: ExtensionContext) {
    let config = workspace.getConfiguration();
    const enabled = config.get("phpstan.enabled", true);
    const path = config.get<string>("phpstan.path", null);
    const level = config.get<string>("phpstan.level", "max");
    const memoryLimit = config.get<string>("phpstan.memoryLimit", "2048M");
    const options = config.get<string[]>("phpstan.options", []);
    const projectFile = config.get<string>("phpstan.projectFile", null);

    workspace.onDidChangeConfiguration((e) => {
        config = workspace.getConfiguration();

        if (e.affectsConfiguration("phpstan.enabled")) {
            phpstan.enabled = config.get("phpstan.enabled", true);
        } else if (e.affectsConfiguration("phpstan.path")) {
            phpstan.path = config.get<string>("phpstan.path", null);
        } else if (e.affectsConfiguration("phpstan.level")) {
            phpstan.level = config.get("phpstan.level", "max");
        } else if (e.affectsConfiguration("phpstan.memoryLimit")) {
            phpstan.memoryLimit = config.get("phpstan.memoryLimit", "2048M");
        } else if (e.affectsConfiguration("phpstan.options")) {
            phpstan.options = config.get<string[]>("phpstan.options", []);
        } else if (e.affectsConfiguration("phpstan.projectFile")) {
            phpstan.projectFile = config.get<string>("phpstan.projectFile", null);
        }
    });

    let phpstan = new PHPStan({
        path,
        options,
        memoryLimit,
        level,
        enabled,
        projectFile
    });
    let controller = new PHPStanController(phpstan);

    context.subscriptions.push(controller);
    context.subscriptions.push(phpstan);
    context.subscriptions.push(phpstan.diagnosticCollection);
}