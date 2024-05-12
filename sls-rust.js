//@ts-check
'use strict'

const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { stdin } = require('node:process')

/**
 * @typedef {import("serverless").FunctionDefinitionHandler} FunctionDefinitionHandler
 */

/**
 * @typedef 
   { "black" 
   | "red" 
   | "green" 
   | "yellow" 
   | "blue" 
   | "magenta" 
   | "cyan" 
   | "white" 
   | "default" 
   | "reset" } ColorName
 * @param {string} text
 * @param {Object} colors
 * @param {ColorName} [colors.fg]
 * @param {ColorName} [colors.bg]
 * */
function withColor(text, { fg, bg }) {
  if (!stdin.isTTY) return text

  const ansiPrefix = '\x1b['
  /** @type {{ [key in ColorName]: number }} */
  const colors = {
    black: 30,
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,
    default: 39,
    reset: 0,
  }

  /** @param {ColorName | undefined} colorName */
  const getCode = colorName => {
    if (!colorName) return null

    if (colorName === 'reset') return colors.reset

    return colors[colorName]
  }

  /**
   * @param {number?} x
   * @param {number?} y
   */
  const safeAdd = (x, y) => {
    if (x && y) return x + y
    else return null
  }

  const colorCodes = /** @type {string[]} */ (
    [getCode(fg), safeAdd(getCode(bg), 10)].filter(x => x != null).map(x => x?.toString())
  )

  if (colorCodes.length == 0) return text
  else return `${ansiPrefix}${colorCodes.join(';')}m${text}`
}

/** @param {number} index  */
function colorByIndex(index) {
  /** @type {ColorName[]} */
  const colorsByIndex = ['blue', 'yellow', 'green', 'red', 'cyan', 'magenta']
  return index >= 0 ? colorsByIndex[index % colorsByIndex.length] : colorsByIndex[0]
}

class SlsRust {
  useCross = true
  targetRuntime = 'aarch64-unknown-linux-musl'

  /**
   * @param {any} serverless
   * @param {any} options
   */
  constructor(serverless, options) {
    this.serverless = serverless
    this.log = serverless.cli.log
    this.options = options

    serverless.configSchemaHandler.defineTopLevelProperty('rust', {
      type: ['object', 'null'],
      properties: {
        useCross: { type: ['boolean', 'null'] },
        targetRuntime: { type: ['string', 'null'] },
      },
      required: [],
    })

    this.hooks = {
      initialize: this.init.bind(this),
      'before:package:createDeploymentArtifacts': this.buildPrepare.bind(this),
      'before:deploy:function:packageFunction': this.buildPrepare.bind(this),
      'before:offline:start': this.buildPrepare.bind(this),
      'before:offline:start:init': this.buildPrepare.bind(this),
    }

    this.serverless.service.package.excludeDevDependencies = false
  }

  init() {
    const service = this.serverless.service
    const config = service.initialServerlessConfig

    this.useCross = config.rust?.useCross ?? this.useCross
    this.targetRuntime = config.rust?.targetRuntime ?? this.targetRuntime
  }

  async buildPrepare() {
    const service = this.serverless.service
    if (service.provider.name !== 'aws') return
    const rustFns = /** @type {string[]} */ (
      this.serverless.service.getAllFunctions().filter((/** @type {string} */ fnName) => {
        const fn = /** @type FunctionDefinitionHandler */ (service.getFunction(fnName))
        return fn.tags?.rust === 'true'
      })
    )

    if (rustFns.length === 0) {
      throw new SlsRustPluginNoRustFnsError()
    }

    const buildPromises = rustFns.map((fnName, index) => {
      const fn = this.serverless.service.getFunction(fnName)
      return this.build(fn, index)
    })

    await Promise.all(buildPromises)
    this.log('finished building all rust functions!')
  }

  /**
   * @param {Object} options
   * @param {string} options.command
   * @param {string} options.cwd
   * @param {string} options.projectName
   * @param {number} [options.index]
   */
  runCommand({ command, cwd, projectName, index }) {
    const [mainCommand, ...args] = command.split(' ')
    const isVerbose = this.serverless.service.serverless.variables.options.verbose
    return new Promise((resolve, reject) => {
      const build = spawn(mainCommand, args, { cwd })
      build.on('error', (/** @type {any} */ error) => {
        reject(error.toString())
      })
      build.on('close', (/** @type {any} */ code) => {
        resolve(code)
      })

      if (isVerbose) {
        build.stdout.on('data', (/** @type {string} */ data) => {
          const color = index !== undefined ? colorByIndex(index) : 'default'
          const prefix = withColor(`${projectName} | `, { fg: color })
          const output = withColor(data, { fg: 'default' })
          console.log(`${prefix}${output}`)
        })
      }
    })
  }

  /**
   * @param {Object} options
   * @param {string} options.path
   * @param {string} options.projectName
   * @param {number} [options.index]
   */
  async runBuildCommand({ path, projectName, index }) {
    try {
      const command = this.useCross ? 'cross' : 'cargo'
      await this.runCommand({
        command: `${command} build --release --target ${this.targetRuntime}`,
        cwd: path,
        projectName,
        index,
      })
    } catch (error) {
      throw new Error(`Error building project ${projectName}: ${error}`)
    }
  }

  /**
   * @param {Object} options
   * @param {string} options.path
   * @param {string} options.projectName
   * @param {number} [options.index]
   */
  async runZipArtifact({ path, projectName, index }) {
    const projectDir = `${projectName}-dir`
    const projectFullPath = join(projectDir, projectName)
    const bootstrapFullPath = join(projectDir, 'bootstrap')

    /** @param {string} command */
    const runCommand = async command => {
      await this.runCommand({
        projectName,
        cwd: path,
        command: command,
        index,
      })
    }

    try {
      await runCommand(`rm ${projectName}.zip`)
      await runCommand(`rm bootstrap`)
      await runCommand(`rm -rf ${projectDir}`)
      await runCommand(`mkdir ${projectDir}`)
      await runCommand(`mv ${projectName} ${projectDir}/`)
      await runCommand(`mv ${projectFullPath} ${bootstrapFullPath}`)
      await runCommand(`zip -j ${projectFullPath}.zip ${bootstrapFullPath}`)
      await runCommand(`mv ${projectFullPath}.zip .`)
    } catch (error) {
      throw new Error(`Error trying to zip artefact in ${projectName}: ${error}`)
    }
  }

  /** @param {import("serverless").FunctionDefinitionHandler} fn
   * @param {number} index
   * */
  async build(fn, index) {
    const { projectPath, projectName } = this.getProjectPathAndName(fn)

    const startMessage = `Building Rust ${fn.handler} func for ${this.targetRuntime}${this.useCross ? ' using cross' : '...'}`

    this.log(startMessage)
    const path = join('.', projectPath)
    const targetPath = join(path, 'target', this.targetRuntime, 'release')
    await this.runBuildCommand({ path, projectName, index })
    await this.runZipArtifact({ path: targetPath, projectName, index })

    const artifactPath = join(targetPath, `${projectName}.zip`)
    fn.package = fn.package || {}
    fn.package.artifact = artifactPath
    fn.runtime = fn.runtime ?? 'provided.al2'
    this.log(`Finished building ${projectName}!`)
  }

  /** @param {import("serverless").FunctionDefinitionHandler} fn */
  getProjectPathAndName(fn) {
    const [projectPath, projectName] = fn.handler.split('.')
    if (!projectPath || !projectName) {
      throw new SlsRustPluginWrongHandlerError()
    }

    return { projectPath, projectName }
  }
}

class SlsRustPluginMainError extends Error {
  constructor({ name, message }) {
    super()
    this.name = `SlsRustPlugin${name}Error`
    this.message = `[sls-rust plugin] ${message}`
  }
}

class SlsRustPluginNoRustFnsError extends SlsRustPluginMainError {
  constructor() {
    super({
      name: 'NoRustFns',
      message: [
        'no Rust functions found. In order to use this plugin, you must put ',
        '`tags.rust: true` in your function configuration, like this:',
        `

# serverless.yml
functions:
  rust:
    handler: your_rust_project_name
    runtime: provided.al2
    tags:
      rust: true
      `,
      ].join(''),
    })
  }
}

class SlsRustPluginWrongHandlerError extends SlsRustPluginMainError {
  constructor() {
    super({
      name: 'WrongHandler',
      message: [
        'the handler of your function must follow the pattern: ',
        'project_path.project_name, when `project_path` is the path of your ',
        'project, and `project_name` is the name of your project in Cargo.toml.\n',
      ].join(''),
    })
  }
}

module.exports = SlsRust
