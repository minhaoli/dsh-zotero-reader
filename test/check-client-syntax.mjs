#!/usr/bin/env node
/**
 * Compile-check client.js before reloading the interface.
 *
 * Two ways this bundle has broken the boot: a duplicate declaration (a SyntaxError, caught by any
 * compile) and a call to a function that was edited away (a ReferenceError, which no compile sees).
 * This catches the first, and registers the module the way the host does so a factory that throws
 * before exporting fails here instead of inside the app.
 *
 * Usage: node test/check-client-syntax.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

const file = new URL('../client.js', import.meta.url)
const code = readFileSync(file, 'utf8')

try {
	new Script(code, { filename: 'client.js' })
} catch (error) {
	console.error(`client.js does not compile: ${error.message}`)
	process.exit(1)
}

const stub = () =>
	new Proxy(function () {}, {
		get: (_target, key) => (key === 'then' ? undefined : stub()),
		apply: () => stub(),
		construct: () => stub(),
	})
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
let registration = null
const sandbox = {
	window: {
		__ModuleLoader__: {
			load: (row) => {
				registration = row
				return row
			},
			mode: 'live',
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		localStorage: storage,
		sessionStorage: storage,
		location: { href: 'dsh-app://app/' },
		dshDesktop: { keyboard: stub() },
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	},
	document: {
		createElement: () => stub(),
		getElementById: () => null,
		querySelector: () => null,
		querySelectorAll: () => [],
		addEventListener: () => {},
		head: { appendChild: () => {} },
		body: { appendChild: () => {} },
	},
	navigator: { userAgent: 'node', language: 'zh-CN' },
	console,
	setTimeout: () => 1,
	clearTimeout: () => {},
	setInterval: () => 1,
	clearInterval: () => {},
	queueMicrotask: () => {},
	fetch: () => new Promise(() => {}),
	URL,
	URLSearchParams,
	TextEncoder,
	TextDecoder,
	Promise,
	Map,
	Set,
	WeakMap,
	WeakSet,
	JSON,
	Math,
	Date,
	Object,
	Array,
	String,
	Number,
	Boolean,
	RegExp,
	Error,
	TypeError,
	Symbol,
	localStorage: storage,
	sessionStorage: storage,
	MutationObserver: stub(),
	ResizeObserver: stub(),
	getComputedStyle: () => stub(),
	structuredClone: (value) => value,
	performance: { now: () => 0 },
}
sandbox.globalThis = sandbox

try {
	new Script(code, { filename: 'client.js' }).runInContext(createContext(sandbox))
} catch (error) {
	console.error(`client.js throws while registering: ${error.message}`)
	process.exit(1)
}
if (registration === null || typeof registration.id !== 'string' || registration.id === '') {
	console.error('client.js did not register a module id')
	process.exit(1)
}
try {
	const exports = registration.factory(() => stub())
	const keys = Object.keys(exports ?? {})
	if (!keys.includes('apply')) {
		console.error(`client.js exported no apply: ${keys.join(',') || '(nothing)'}`)
		process.exit(1)
	}
} catch (error) {
	console.error(`client.js factory throws: ${error.message}`)
	process.exit(1)
}
console.log(`client.js ok: ${code.split('\n').length} lines, id ${registration.id}`)
