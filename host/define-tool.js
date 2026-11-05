/**
 * defineTool 的本地等价实现。
 *
 * 为什么自己写：宿主提供的 `defineTool` 在包 `@deepseek-ai/dsh-tools` 里，该包住在
 * app.asar 内、由 DSH 的插件加载器解析，磁盘上 node_modules 里并不存在。插件一旦
 * 走 link 安装，import 它的解析结果就取决于 loader 的内部路径，属于不必承担的风险。
 *
 * 来源说明：这个「规整简写 schema」的思路参考了 @ggboy123/dsh-paper-reader（MIT）
 * 里工具声明的写法 —— 见 https://github.com/GGboya/dsh-paper-reader
 * 代码是照着观察到的产物形态自己实现的，没有复制其源码。
 *
 * 它做的事只有两件：
 *   1. 属性上的 `required: true` 收进父级的 `required: []` 数组；
 *   2. `parameters` 允许写成「属性名 → schema」的裸 map，自动包成 object schema。
 * `ctx.tools.register` 接受的就是处理完的纯对象，所以产物完全等价。
 */

const LITERAL_KEYS = new Set(['enum', 'const', 'default', 'examples', 'description', 'title'])

/** 把简写 schema 规整成标准 JSON Schema。返回新对象，不改入参。 */
export function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(normalizeSchema)

  const out = {}
  const collectedRequired = []

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required') {
      if (Array.isArray(value)) out.required = [...value]
      // required: true / false 由父级收集，这里丢弃
      continue
    }
    if (LITERAL_KEYS.has(key)) {
      out[key] = value
      continue
    }
    if (key === 'properties' && value && typeof value === 'object') {
      const props = {}
      for (const [name, propSchema] of Object.entries(value)) {
        if (propSchema && typeof propSchema === 'object' && propSchema.required === true) {
          collectedRequired.push(name)
        }
        props[name] = normalizeSchema(propSchema)
      }
      out.properties = props
      continue
    }
    if (['oneOf', 'anyOf', 'allOf', 'prefixItems'].includes(key) && Array.isArray(value)) {
      out[key] = value.map(normalizeSchema)
      continue
    }
    if (key === 'definitions' && value && typeof value === 'object') {
      out.definitions = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeSchema(v)]))
      continue
    }
    if (['items', 'additionalProperties', 'not', 'contains', 'propertyNames'].includes(key)
      && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = normalizeSchema(value)
      continue
    }
    out[key] = value
  }

  if (collectedRequired.length > 0) {
    const merged = new Set([...(out.required ?? []), ...collectedRequired])
    out.required = [...merged]
  }
  return out
}

/**
 * 把「属性名 → schema」的裸 map 包成 object schema。
 * 已经是 `{type:'object', properties:{...}}` 形态的原样规整。
 */
export function normalizeParameters(parameters) {
  if (!parameters || typeof parameters !== 'object') {
    return { type: 'object', properties: {} }
  }
  const isObjectSchema = parameters.type === 'object' || 'properties' in parameters
  if (isObjectSchema) return normalizeSchema(parameters)
  return normalizeSchema({ type: 'object', properties: parameters })
}

/**
 * 与宿主 defineTool 同签名：规整 parameters 与 output.schema，其余字段原样透传。
 * @param {object} definition
 * @returns {object}
 */
export function defineTool(definition) {
  return {
    ...definition,
    parameters: normalizeParameters(definition.parameters),
    output: {
      ...definition.output,
      schema: normalizeSchema(definition.output?.schema ?? { type: 'object' }),
    },
  }
}
