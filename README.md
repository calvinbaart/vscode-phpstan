[![](https://vsmarketplacebadge.apphb.com/version-short/calsmurf2904.vscode-phpstan.svg)](https://marketplace.visualstudio.com/items?itemName=calsmurf2904.vscode-phpstan)
[![](https://vsmarketplacebadge.apphb.com/installs-short/calsmurf2904.vscode-phpstan.svg)](https://marketplace.visualstudio.com/items?itemName=calsmurf2904.vscode-phpstan)
[![](https://vsmarketplacebadge.apphb.com/rating-short/calsmurf2904.vscode-phpstan.svg)](https://marketplace.visualstudio.com/items?itemName=calsmurf2904.vscode-phpstan)

<p align="center">
  <br />
  <img src="https://puu.sh/zkXAe/e727a924d6.png" alt="Image Sample" />
</p>

## What is this?

[PHPStan](https://github.com/phpstan/phpstan) is a static analysis tool for PHP. This extension aims to use the output of PHPStan and integrate it in VSCode allowing the
developer to find errors quicker.

## Installation

PHPStan is required to use this extension. By default the plugin will search the global vendor folder and the workspace vendor folders.
The COMPOSER_HOME environment variable can be set to change where the plugin searches.
This path can be manually set using the ``phpstan.path`` setting.

PHPStan can be installed globally using:

```bash
composer global require phpstan/phpstan
```

or locally using:

```bash
composer require --dev phpstan/phpstan
```

## Configuration

vscode-phpstan provides the following configuration properties and defaults:

```json
"phpstan.enabled": true,
"phpstan.path": null,
"phpstan.level": "max",
"phpstan.memoryLimit": "2048M",
"phpstan.options": []
```

phpstan.options can be used to pass extra parameters to the phpstan commandline call.