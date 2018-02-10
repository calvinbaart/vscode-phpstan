import { ExtensionContext } from "vscode";
import { PHPStan } from "./phpstan";
import { PHPStanController } from "./controller";

export function activate(context: ExtensionContext)
{
    let phpstan = new PHPStan();
    let controller = new PHPStanController(phpstan);

    context.subscriptions.push(controller);
    context.subscriptions.push(phpstan);
    context.subscriptions.push(phpstan.diagnosticCollection);
}