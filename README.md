# vscode-phpstan

## Installation

PHPStan is required to use this extension. By default the plugin will search the global vendor folder and the workspace vendor folders.
The COMPOSER_HOME environment variable can be set to change where the plugin searches.

PHPStan can be installed globally using:

```bash
composer global require phpstan/phpstan
```

or locally using:

```bash
composer require --dev phpstan/phpstan
```