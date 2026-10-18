/**
 * A dependency-free JSON-Schema subset validator (task-111).
 *
 * WHY NOT AJV. `scripts/ext-matrix.mjs` runs from the repository root as plain
 * ESM, and the extension matrix must work on a machine with no installed root
 * dependencies. The fixtures and validators are therefore deliberately
 * dependency-free, and this module is the small validator they share.
 *
 * WHAT IT SUPPORTS — exactly the keywords the eight extension packages and the
 * four standard contracts in this matrix actually declare:
 *
 *   type (single or union), const, enum, required, properties,
 *   additionalProperties (false or a schema), items (schema or tuple),
 *   minItems, maxItems, uniqueItems, minimum, maximum, exclusiveMinimum,
 *   exclusiveMaximum, minLength, maxLength, pattern, allOf, anyOf, oneOf,
 *   `if` / `then` / `else`, `not`, and local `$ref` into `$defs`/`definitions`.
 *
 * It is NOT a general JSON-Schema implementation. A keyword it does not
 * understand is IGNORED rather than guessed at, and callers that need a
 * keyword the subset lacks must add it here (with a test) instead of assuming
 * it was enforced. That is the same discipline the host applies to its own
 * schema projection: an unenforced constraint that is advertised as enforced is
 * worse than one that is honestly absent.
 *
 * @module scripts/lib/json-schema-subset
 */

/* oxlint-disable anti-slop/no-runtime-typeof */
/*
 * Justification for the disable above: a JSON-Schema validator IS the parse
 * boundary. `typeof` here is the schema's `type` keyword being enforced on
 * untyped input, not a representation shortcut after parsing; the domain value
 * this module produces is the `string[]` of violations, which is fixed.
 */

/** A JSON pointer segment, decoded per RFC 6901. */
function decodePointer(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** Resolve a local `#/...` `$ref` against its root schema. */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined
  let node = root
  for (const raw of ref.slice(2).split('/')) {
    const key = decodePointer(raw)
    if (typeof node !== 'object' || node === null || !(key in node)) return undefined
    node = node[key]
  }
  return node
}

/** JSON structural equality, enough for const/enum/uniqueItems. */
export function jsonEqual(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (typeof left !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => jsonEqual(item, right[index]))
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
}

/** Whether a value is the given JSON-Schema type. */
export function matchesType(type, value) {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      // An unknown type name is not a constraint this subset can enforce; the
      // caller sees no violation rather than a fabricated one. The tests pin
      // that every type name used by the matrix schemas is one of the above.
      return true
  }
}

/** Describe a value's JSON type for an issue message. */
function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  return typeof value
}

/** Character count by code point, which is what JSON Schema `maxLength` means. */
function characterCount(text) {
  return [...text].length
}

/**
 * Validate one value against a schema node.
 * @param schema - the schema node (or boolean schema).
 * @param value - the value to validate.
 * @param root - the root schema, for local `$ref` resolution.
 * @param path - the instance path, for issue messages.
 * @returns every violation found, as readable strings.
 */
function validateNode(schema, value, root, path) {
  if (schema === true || schema === undefined) return []
  if (schema === false) return [`${path} must not be present`]
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path}: the schema node is not an object, so it cannot be checked`]
  }

  const issues = []

  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(root, schema.$ref)
    if (resolved === undefined) return [`${path}: the schema declares an unresolvable $ref ${JSON.stringify(schema.$ref)}`]
    return validateNode(resolved, value, root, path)
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => matchesType(type, value))) {
      return [`${path} must be of type ${types.join(' or ')}, saw ${describeValue(value)}`]
    }
  }

  if (Object.hasOwn(schema, 'const') && !jsonEqual(schema.const, value)) {
    issues.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(entry => jsonEqual(entry, value))) {
    issues.push(`${path} must be one of ${schema.enum.map(entry => JSON.stringify(entry)).join(', ')}`)
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push(`${path} must be >= ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push(`${path} must be <= ${schema.maximum}`)
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      issues.push(`${path} must be > ${schema.exclusiveMinimum}`)
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      issues.push(`${path} must be < ${schema.exclusiveMaximum}`)
    }
  }

  if (typeof value === 'string') {
    const length = characterCount(value)
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      issues.push(`${path} must have at least ${schema.minLength} characters, saw ${length}`)
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      issues.push(`${path} must have at most ${schema.maxLength} characters, saw ${length}`)
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) {
          issues.push(`${path} must match ${JSON.stringify(schema.pattern)}`)
        }
      } catch {
        issues.push(`${path}: the schema pattern ${JSON.stringify(schema.pattern)} does not compile, so it cannot be checked`)
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push(`${path} must have at least ${schema.minItems} items, saw ${value.length}`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push(`${path} must have at most ${schema.maxItems} items, saw ${value.length}`)
    }
    if (schema.uniqueItems === true) {
      for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          if (jsonEqual(value[left], value[right])) {
            issues.push(`${path} must not contain duplicate items (${JSON.stringify(value[left])})`)
            left = value.length
            break
          }
        }
      }
    }
    if (Array.isArray(schema.items)) {
      // Tuple form: items[i] constrains value[i]; extra items fall to additionalItems.
      for (const [index, itemSchema] of schema.items.entries()) {
        if (index < value.length) issues.push(...validateNode(itemSchema, value[index], root, `${path}[${index}]`))
      }
    } else if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        issues.push(...validateNode(schema.items, item, root, `${path}[${index}]`))
      }
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const properties = typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!Object.hasOwn(value, name)) issues.push(`${path} is missing required property ${JSON.stringify(name)}`)
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) {
        issues.push(...validateNode(propertySchema, value[name], root, `${path}.${name}`))
      }
    }
    const additional = schema.additionalProperties
    if (additional === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) issues.push(`${path} must not have the additional property ${JSON.stringify(name)}`)
      }
    } else if (typeof additional === 'object' && additional !== null) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) {
          issues.push(...validateNode(additional, value[name], root, `${path}.${name}`))
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const [index, branch] of schema.allOf.entries()) {
      issues.push(...validateNode(branch, value, root, path).map(issue => `allOf[${index}] ${issue}`))
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const branchIssues = schema.anyOf.map(branch => validateNode(branch, value, root, path))
    if (!branchIssues.some(list => list.length === 0)) {
      issues.push(`${path} must match at least one anyOf branch (${branchIssues.map(list => list[0] ?? 'matched').join(' | ')})`)
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const branchIssues = schema.oneOf.map(branch => validateNode(branch, value, root, path))
    const matched = branchIssues.filter(list => list.length === 0).length
    if (matched !== 1) {
      const sample = branchIssues.filter(list => list.length > 0).map(list => list[0]).slice(0, 2).join(' | ')
      issues.push(`${path} must match exactly one of ${schema.oneOf.length} oneOf branches, matched ${matched}${sample === '' ? '' : `; ${sample}`}`)
    }
  }

  if (schema.if !== undefined) {
    const conditionMatches = validateNode(schema.if, value, root, path).length === 0
    if (conditionMatches && schema.then !== undefined) {
      issues.push(...validateNode(schema.then, value, root, path))
    } else if (!conditionMatches && schema.else !== undefined) {
      issues.push(...validateNode(schema.else, value, root, path))
    }
  }

  if (schema.not !== undefined && validateNode(schema.not, value, root, path).length === 0) {
    issues.push(`${path} must NOT match the declared "not" schema`)
  }

  return issues
}

/**
 * Compile a schema into a validator function.
 *
 * The returned function is pure and reusable across calls; it resolves local
 * `$ref`s against the SAME root it was compiled from.
 * @param {Record<string, unknown> | boolean} schema - the root schema.
 * @returns {(value: unknown) => string[]} violations (empty when valid).
 */
export function compileSubset(schema) {
  return value => validateNode(schema, value, schema, '$')
}

/**
 * Validate one value against one schema in a single call.
 * @param {Record<string, unknown> | boolean} schema - the root schema.
 * @param {unknown} value - the value to check.
 * @returns {string[]} violations (empty when valid).
 */
export function validateSchema(schema, value) {
  return compileSubset(schema)(value)
}

/**
 * Whether a value satisfies a schema.
 * @param {Record<string, unknown> | boolean} schema - the root schema.
 * @param {unknown} value - the value to check.
 * @returns {boolean} true when there are no violations.
 */
export function matchesSchema(schema, value) {
  return validateSchema(schema, value).length === 0
}
