"use strict";

const { execSync } = require("child_process");
const assign = require("object-assign");

const UNSATISFIABLE_RULES = [
  "eol-last", // The Markdown parser strips trailing newlines in code fences
  "unicode-bom" // Code blocks will begin in the middle of Markdown files
];

const SUPPORTS_AUTOFIX = true;

const LEADING_WHITESPACE_REGEX = /^\s*/;

let blocks = [];

/**
 * Performs a depth-first traversal to find JS code block in the QML AST.
 * @param {ASTNode} node A Markdown AST node.
 * @param {function} callback A map of node types to callbacks.
 * @param {int} level Node's level
 * @returns {void}
 */
function traverse(node, callback, level = 0) {
  if (
    node.kind === "JavascriptValue" ||
    node.kind === "JavascriptBlock" ||
    node.kind === "Function"
  ) {
    callback(Object.assign({}, node, { level }));
    return;
  }

  if (node.value && node.value.kind) {
    traverse(node.value, callback, level + 1);
  }

  if (node.children && node.children.length > 0) {
    node.children.forEach(childNode =>
      traverse(childNode, callback, level + 1)
    );
  }
}

/**
 * Converts leading HTML comments to JS block comments.
 * @param {string} html The text content of an HTML AST node.
 * @returns {string[]} An array of JS block comments.
 */
function getComment(html) {
  const commentStart = "<!--";
  const commentEnd = "-->";
  const regex = /^(eslint\b|global\s)/;

  if (
    html.slice(0, commentStart.length) !== commentStart ||
    html.slice(-commentEnd.length) !== commentEnd
  ) {
    return "";
  }

  html = html.slice(commentStart.length, -commentEnd.length);

  if (!regex.test(html.trim())) {
    return "";
  }

  return html;
}

/**
 * When applying fixes, the postprocess step needs to know how to map fix ranges
 * from their location in the linted JS to the original offset in the Markdown.
 * Configuration comments and indentation trimming both complicate this process.
 *
 * Configuration comments appear in the linted JS but not in the Markdown code
 * block. Fixes to configuration comments would cause undefined behavior and
 * should be ignored during postprocessing. Fixes to actual code after
 * configuration comments need to be mapped back to the code block after
 * removing any offset due to configuration comments.
 *
 * Fenced code blocks can be indented by up to three spaces at the opening
 * fence. Inside of a list, for example, this indent can be in addition to the
 * indent already required for list item children. Leading whitespace inside
 * indented code blocks is trimmed up to the level of the opening fence and does
 * not appear in the linted code. Further, lines can have less leading
 * whitespace than the opening fence, so not all lines are guaranteed to have
 * the same column offset as the opening fence.
 *
 * The source code of a non-configuration-comment line in the linted JS is a
 * suffix of the corresponding line in the Markdown code block. There are no
 * differences within the line, so the mapping need only provide the offset
 * delta at the beginning of each line.
 *
 * @param {string} text The text of the file.
 * @param {ASTNode} node A Markdown code block AST node.
 * @param {comments} comments List of configuration comment strings that will be
 *     inserted at the beginning of the code block.
 * @returns {object[]} A list of offset-based adjustments, where lookups are
 *     done based on the `js` key, which represents the range in the linted JS,
 *     and the `md` key is the offset delta that, when added to the JS range,
 *     returns the corresponding location in the original Markdown source.
 */
function getBlockRangeMap(text, node, comments) {
  let baseIndent,
    code,
    commentLength,
    i,
    jsOffset,
    leadingWhitespaceLength,
    line,
    lines,
    mdOffset,
    rangeMap,
    startOffset,
    trimLength;

  /*
   * The parser sets the fenced code block's start offset to wherever content
   * should normally begin (typically the first column of the line, but more
   * inside a list item, for example). The code block's opening fance may be
   * further indented by up to three characters. If the code block has
   * additional indenting, the opening fence's first backtick may be up to
   * three whitespace characters after the start offset.
   */
  startOffset = node.loc.start.offset;

  /*
   * Extract the Markdown source to determine the leading whitespace for each
   * line.
   */
  code = node.value;
  lines = code.split("\n");

  /*
   * The parser trims leading whitespace from each line of code within the
   * fenced code block up to the opening fence's first backtick. The first
   * backtick's column is the AST node's starting column plus any additional
   * indentation.
   */
  baseIndent =
    node.loc.start.column -
    1 +
    LEADING_WHITESPACE_REGEX.exec(lines[0])[0].length;

  /*
   * Track the length of any inserted configuration comments at the beginning
   * of the linted JS and start the JS offset lookup keys at this index.
   */
  commentLength = comments.reduce(function(len, comment) {
    return len + comment.length + 1;
  }, 0);

  /*
   * In case there are configuration comments, initialize the map so that the
   * first lookup index is always 0. If there are no configuration comments,
   * the lookup index will also be 0, and the lookup should always go to the
   * last range that matches, skipping this initialization entry.
   */
  rangeMap = [
    {
      js: 0,
      md: 0
    }
  ];

  // Start the JS offset after any configuration comments.
  jsOffset = commentLength;

  /*
   * Start the Markdown offset at the beginning of the block's first line of
   * actual code. The first line of the block is always the opening fence, so
   * the code begins on the second line.
   */
  mdOffset = startOffset + lines[0].length + 1;

  /*
   * For each line, determine how much leading whitespace was trimmed due to
   * indentation. Increase the JS lookup offset by the length of the line
   * post-trimming and the Markdown offset by the total line length.
   */
  for (i = 0; i + 1 < lines.length; i++) {
    line = lines[i + 1];
    leadingWhitespaceLength = LEADING_WHITESPACE_REGEX.exec(line)[0].length;
    // The parser trims leading whitespace up to the level of the opening
    // fence, so keep any additional indentation beyond that.
    trimLength = Math.min(baseIndent, leadingWhitespaceLength);

    rangeMap.push({
      js: jsOffset,
      // Advance `trimLength` character from the beginning of the Markdown
      // line to the beginning of the equivalent JS line, then compute the
      // delta.
      md: mdOffset + trimLength - jsOffset
    });

    // Accumulate the current line in the offsets, and don't forget the
    // newline.
    mdOffset += line.length + 1;
    jsOffset += line.length - trimLength + 1;
  }

  return rangeMap;
}

/**
 * @param {string} str The string to escape
 * @returns {string} The escaped string
 */
function escapeString(str) {
  return str.replace(/("|`)/g, "\\$1");
}

/**
 * @param {string} text The text to parse
 * @returns {object} The AST document
 */
function parse(text) {
  const bin = require.resolve("@oltodo/qml-parser");

  const result = execSync(`${bin} "${escapeString(text)}"`);
  const ast = JSON.parse(result);

  if (ast === null) {
    return {};
  }

  return ast;
}

/**
 * Extracts lintable JavaScript code blocks from Markdown text.
 * @param {string} text The text of the file.
 * @returns {string[]} Source code strings to lint.
 */
function preprocess(text) {
  const ast = parse(text);
  blocks = [];

  traverse(ast, function(node, parent) {
    let value = node.value || node.body;

    // if (node.kind === 'Function') {
    //   value
    // }

    blocks.push(value)
    const comments = [];
    // let index, previousNode, comment;

    // index = parent.children.indexOf(node) - 1;
    // previousNode = parent.children[index];

    // while (previousNode && previousNode.type === "html") {
    //   comment = getComment(previousNode.value);

    //   if (!comment) {
    //     break;
    //   }

    //   if (comment.trim() === "eslint-skip") {
    //     return;
    //   }

    //   comments.unshift("/*" + comment + "*/");
    //   index--;
    //   previousNode = parent.children[index];
    // }

    const data = {
      loc: node.loc,
      indent: node.level * 4,
      value: node.value || node.body
    };

    blocks.push(
      Object.assign({}, data, {
        comments
        // rangeMap: getBlockRangeMap(text, data, comments)
      })
    );
  });

  return blocks;

  // return blocks.map(function(block) {
  //   return block.comments
  //     .concat(block.value)
  //     .concat("")
  //     .join("\n");
  // });
}

/**
 * Creates a map function that adjusts messages in a code block.
 * @param {Block} block A code block.
 * @returns {function} A function that adjusts messages in a code block.
 */
function adjustBlock(block) {
  const leadingCommentLines = block.comments.reduce(
    (count, comment) => count + comment.split("\n").length,
    0
  );

  const blockStart = block.loc.start.line;

  /**
   * Adjusts ESLint messages to point to the correct location in the QML.
   * @param {Message} message A message from ESLint.
   * @returns {Message} The same message, but adjusted ot the correct location.
   */
  return function adjustMessage(message) {
    console.log(message.message);

    const lineInCode = message.line - leadingCommentLines;
    const endLine = message.endLine - leadingCommentLines;

    console.log();
    console.log("leadingCommentLines: ", leadingCommentLines);
    console.log("lineInCode: ", lineInCode);
    console.log("endLine: ", endLine);

    if (lineInCode < 1) {
      return null;
    }

    const out = {
      line: lineInCode + blockStart,
      endLine: endLine ? endLine + blockStart : endLine,
      column: message.column + block.indent - 1
    };

    // const adjustedFix = {};
    // if (message.fix) {
    //   adjustedFix.fix = {
    //     range: message.fix.range.map(function(range) {
    //       // Advance through the block's range map to find the last
    //       // matching range by finding the first range too far and
    //       // then going back one.
    //       let i = 1;
    //       while (i < block.rangeMap.length && block.rangeMap[i].js < range) {
    //         i++;
    //       }

    //       // Apply the mapping delta for this range.
    //       return range + block.rangeMap[i - 1].md;
    //     }),
    //     text: message.fix.text
    //   };
    // }

    console.log("--------------------------------");
    return assign({}, message, out /*, adjustedFix*/);
  };
}

/**
 * Excludes unsatisfiable rules from the list of messages.
 * @param {Message} message A message from the linter.
 * @returns {boolean} True if the message should be included in output.
 */
function excludeUnsatisfiableRules(message) {
  return message && UNSATISFIABLE_RULES.indexOf(message.ruleId) < 0;
}

/**
 * Transforms generated messages for output.
 * @param {Array<Message[]>} groups An array containing arrays of messages
 *     for each code block returned from `preprocess`.
 * @returns {Message[]} A flattened array of messages with mapped locations.
 */
function postprocess(groups) {
  return [].concat.apply(
    [],
    groups.map((group, i) => {
      // const adjust = adjustBlock(blocks[i]);
      // return group.map(adjust).filter(excludeUnsatisfiableRules);
      return group;
    })
  );
}

module.exports = {
  preprocess: preprocess,
  postprocess: postprocess
  // supportsAutofix: SUPPORTS_AUTOFIX
};
