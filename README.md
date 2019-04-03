# eslint-plugin-qml

An [ESLint](http://eslint.org/) plugin to lint JavaScript in QML files (`.qml` extension).

## Usage

Install the plugin:

```sh
npm install --save-dev eslint eslint-plugin-qml
```

Add it to your `.eslintrc`:

```json
{
    "plugins": ["qml"]
}
```

Run ESLint on `.qml` files:

```sh
eslint --ext qml .
```

It will lint Javascript blocks and functions in your QML documents:

```qml
Rectangle {
    Text {
        title: ''
    }

    function hello() {
        title.text = "Hello World";
    }

    Component.onCompleted: hello()
}
```

## Tips for use with Atom linter-eslint

The [linter-eslint](https://atom.io/packages/linter-eslint) package allows for
linting within the [Atom IDE](https://atom.io/).

In order to see `eslint-plugin-qml` work its magic within QML code
blocks in your Atom editor, you can go to `linter-eslint`'s settings and
within "List of scopes to run ESLint on...", add the cursor scope "source.gfm".

However, this reports a problem when viewing QML which does not have
configuration, so you may wish to use the cursor scope "source.embedded.js",
but note that `eslint-plugin-qml` configuration comments and skip
directives won't work in this context.

## Contributing

```sh
$ git clone https://github.com/oltodo/eslint-plugin-qml.git
$ cd eslint-plugin-qml
$ npm install
$ npm test
```

This project follows the [ESLint contribution guidelines](http://eslint.org/docs/developer-guide/contributing/).
