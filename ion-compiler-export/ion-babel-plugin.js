/**
 * Ion Babel Plugin
 * Adds data-ion-id, data-ion-caller-id, and data-ion-path attributes to JSX elements.
 *
 * data-ion-id        base64 JSON {path, startTag:{start,end}, component} — line/column-perfect.
 * data-ion-caller-id base64 JSON {caller, depth} — call-site for cross-component identity.
 * data-ion-path      plain string "Component/tag[ord]/tag[ord]" — structural path stable across line moves.
 */

const ATTRIBUTE_NAME = 'data-ion-id';
const CALLER_ATTRIBUTE_NAME = 'data-ion-caller-id';
const PATH_ATTRIBUTE_NAME = 'data-ion-path';

// Default script(s) injected into <body>. Override with the plugin option
// `injectScripts: ['/ion-injection.js', '/crit-overlay.js']`.
const DEFAULT_INJECT_SCRIPTS = ['/ion-injection.js'];

function encodeNodeInfo(nodeInfo) {
  return Buffer.from(JSON.stringify(nodeInfo)).toString('base64');
}

module.exports = function ionBabelPlugin({ types: t }, options = {}) {
  const injectScripts =
    Array.isArray(options.injectScripts) && options.injectScripts.length > 0
      ? options.injectScripts
      : DEFAULT_INJECT_SCRIPTS;
  let currentFilePath = '';
  let currentComponentName = null;
  const componentStack = [];
  // Structural-path stack. Frames: { prefix, counters }. Component entries push a
  // root frame; JSXElements push child frames; fragments are transparent.
  const pathStack = [];

  function isReactFragment(node) {
    if (!node) return false;

    // Check for <Fragment>
    if (t.isJSXIdentifier(node.name)) {
      return node.name.name === 'Fragment';
    }

    // Check for <React.Fragment>
    if (t.isJSXMemberExpression(node.name)) {
      const { object, property } = node.name;
      return (
        t.isJSXIdentifier(object) &&
        object.name === 'React' &&
        t.isJSXIdentifier(property) &&
        property.name === 'Fragment'
      );
    }

    return false;
  }

  function hasAttribute(node, attributeName) {
    if (!node.attributes) return false;
    return node.attributes.some(
      (attr) => t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === attributeName
    );
  }

  function getJsxTagName(openingElement) {
    if (!openingElement || !openingElement.name) return 'unknown';
    const name = openingElement.name;
    if (t.isJSXIdentifier(name)) return name.name;
    if (t.isJSXMemberExpression(name)) {
      const parts = [];
      let cur = name;
      while (t.isJSXMemberExpression(cur)) {
        parts.unshift(cur.property.name);
        cur = cur.object;
      }
      if (t.isJSXIdentifier(cur)) parts.unshift(cur.name);
      return parts.join('.');
    }
    if (t.isJSXNamespacedName(name)) {
      return name.namespace.name + ':' + name.name.name;
    }
    return 'unknown';
  }

  function buildStructuralPath(openingElement) {
    if (pathStack.length === 0) return null;
    const tagName = getJsxTagName(openingElement);
    const top = pathStack[pathStack.length - 1];
    const ord = top.counters[tagName] || 0;
    top.counters[tagName] = ord + 1;
    const segment = tagName + '[' + ord + ']';
    return top.prefix + '/' + segment;
  }

  function createNodeInfo(path) {
    const node = path.node;

    if (!node.loc) return null;

    const nodeInfo = {
      path: currentFilePath,
      startTag: {
        start: {
          line: node.loc.start.line,
          column: node.loc.start.column,
        },
        end: {
          line: node.loc.end.line,
          column: node.loc.end.column,
        },
      },
    };

    // Add component name if we're inside a component
    if (currentComponentName) {
      nodeInfo.component = currentComponentName;
    }

    return nodeInfo;
  }

  function addIonAttribute(path, nodeInfo, structuralPath) {
    const openingElement = path.node.openingElement;

    // Skip if already has the attribute
    if (hasAttribute(openingElement, ATTRIBUTE_NAME)) {
      return;
    }

    // Skip fragments
    if (isReactFragment(openingElement)) {
      return;
    }

    // Create the data-ion-id attribute with encoded node info
    const encodedInfo = encodeNodeInfo(nodeInfo);
    const ionAttribute = t.jsxAttribute(t.jsxIdentifier(ATTRIBUTE_NAME), t.stringLiteral(encodedInfo));

    openingElement.attributes.push(ionAttribute);

    // Add caller attribute if we're inside a component and there's a parent component
    if (componentStack.length > 0) {
      const callerInfo = {
        caller: componentStack[componentStack.length - 1],
        depth: componentStack.length,
      };
      const callerAttribute = t.jsxAttribute(
        t.jsxIdentifier(CALLER_ATTRIBUTE_NAME),
        t.stringLiteral(Buffer.from(JSON.stringify(callerInfo)).toString('base64'))
      );
      openingElement.attributes.push(callerAttribute);
    }

    // Structural path attribute — only emitted when there's a parent component frame
    // (i.e. the element is inside a tracked function component).
    if (structuralPath) {
      const pathAttribute = t.jsxAttribute(
        t.jsxIdentifier(PATH_ATTRIBUTE_NAME),
        t.stringLiteral(structuralPath)
      );
      openingElement.attributes.push(pathAttribute);
    }
  }

  return {
    name: 'ion-babel-plugin',
    visitor: {
      Program: {
        enter(path, state) {
          currentFilePath = state.filename || 'unknown';
          currentComponentName = null;
          componentStack.length = 0;
          pathStack.length = 0;
        },
        exit() {
          currentFilePath = '';
          currentComponentName = null;
          componentStack.length = 0;
          pathStack.length = 0;
        },
      },

      // Track function components — push a path-stack frame keyed on the component name.
      FunctionDeclaration: {
        enter(path) {
          const name = path.node.id?.name;
          if (name && /^[A-Z]/.test(name)) {
            currentComponentName = name;
            componentStack.push(name);
            pathStack.push({ prefix: name, counters: {} });
          }
        },
        exit(path) {
          const name = path.node.id?.name;
          if (name && /^[A-Z]/.test(name)) {
            componentStack.pop();
            currentComponentName = componentStack[componentStack.length - 1] || null;
            pathStack.pop();
          }
        },
      },

      // Track arrow function components
      VariableDeclarator: {
        enter(path) {
          const name = path.node.id?.name;
          if (
            name &&
            /^[A-Z]/.test(name) &&
            (t.isArrowFunctionExpression(path.node.init) || t.isFunctionExpression(path.node.init))
          ) {
            currentComponentName = name;
            componentStack.push(name);
            pathStack.push({ prefix: name, counters: {} });
          }
        },
        exit(path) {
          const name = path.node.id?.name;
          if (
            name &&
            /^[A-Z]/.test(name) &&
            (t.isArrowFunctionExpression(path.node.init) || t.isFunctionExpression(path.node.init))
          ) {
            componentStack.pop();
            currentComponentName = componentStack[componentStack.length - 1] || null;
            pathStack.pop();
          }
        },
      },

      JSXElement: {
        enter(path) {
          const openingElement = path.node.openingElement;
          if (isReactFragment(openingElement)) return;

          const nodeInfo = createNodeInfo(path);
          const structuralPath = buildStructuralPath(openingElement);

          if (nodeInfo) {
            addIonAttribute(path, nodeInfo, structuralPath);
          }

          pathStack.push({
            prefix: structuralPath || (currentComponentName || 'Unknown'),
            counters: {},
          });

          // Inject <script src="..." async={true} /> tags into <body> elements.
          // This must happen in the babel plugin (not post-processing) because the file
          // watcher re-transforms files, which would overwrite any post-processing changes.
          if (t.isJSXIdentifier(openingElement.name) && openingElement.name.name === 'body') {
            for (const scriptSrc of injectScripts) {
              const alreadyInjected = path.node.children.some(
                (child) =>
                  t.isJSXElement(child) &&
                  t.isJSXIdentifier(child.openingElement.name) &&
                  child.openingElement.name.name === 'script' &&
                  child.openingElement.attributes.some(
                    (attr) =>
                      t.isJSXAttribute(attr) &&
                      t.isJSXIdentifier(attr.name) &&
                      attr.name.name === 'src' &&
                      t.isStringLiteral(attr.value) &&
                      attr.value.value === scriptSrc
                  )
              );
              if (alreadyInjected) continue;
              const scriptElement = t.jsxElement(
                t.jsxOpeningElement(
                  t.jsxIdentifier('script'),
                  [
                    t.jsxAttribute(t.jsxIdentifier('src'), t.stringLiteral(scriptSrc)),
                    t.jsxAttribute(t.jsxIdentifier('async'), t.jsxExpressionContainer(t.booleanLiteral(true))),
                  ],
                  true
                ),
                null,
                [],
                true
              );
              path.node.children.unshift(scriptElement);
            }
          }
        },
        exit(path) {
          if (isReactFragment(path.node.openingElement)) return;
          pathStack.pop();
        },
      },
    },
  };
};
