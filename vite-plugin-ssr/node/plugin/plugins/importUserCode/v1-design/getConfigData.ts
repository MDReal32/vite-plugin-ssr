export { getConfigData }

import {
  determinePageId2,
  determineRouteFromFilesystemPath
} from '../../../../../shared/route/deduceRouteStringFromFilesystemPath'
import {
  assertPosixPath,
  assert,
  isObject,
  assertUsage,
  isPosixPath,
  toPosixPath,
  assertWarning,
  addFileExtensionsToRequireResolve,
  assertDefaultExport,
  assertDefaultExportObject,
  objectEntries,
  scriptFileExtensions,
  transpileAndLoadScriptFile,
  objectAssign,
  hasProp,
  arrayIncludes,
  objectKeys,
  assertIsVitePluginCode,
  getMostSimilar
} from '../../../utils'
import path from 'path'
import type {
  ConfigName,
  ConfigSource,
  c_Env,
  PageConfigData,
  PageConfigGlobalData
} from '../../../../../shared/page-configs/PageConfig'
import { configDefinitionsBuiltIn, type ConfigDefinition } from './getConfigData/configDefinitionsBuiltIn'
import glob from 'fast-glob'

assertIsVitePluginCode()

type ConfigData = {
  pageConfigsData: PageConfigData[]
  pageConfigGlobal: PageConfigGlobalData
  vikeConfig: Record<string, unknown>
  vikeConfigFilePath: string | null
}
let configDataPromise: Promise<ConfigData> | null = null
let isFirstInvalidation = true

type ConfigDefinitionsAll = Record<string, ConfigDefinition>

type GlobalConfigName =
  | 'onPrerenderStart'
  | 'onBeforeRoute'
  | 'prerender'
  | 'extensions'
  | 'disableAutoFullBuild'
  | 'includeAssetsImportedByServer'
  | 'baseAssets'
  | 'baseServer'
const globalConfigsDefinition: Record<GlobalConfigName, ConfigDefinition> = {
  onPrerenderStart: {
    c_code: true,
    c_env: 'server-only'
  },
  onBeforeRoute: {
    c_code: true,
    c_env: 'c_routing'
  },
  prerender: {
    c_env: 'c_config'
  },
  extensions: { c_env: 'c_config' },
  disableAutoFullBuild: { c_env: 'c_config' },
  includeAssetsImportedByServer: { c_env: 'c_config' },
  baseAssets: { c_env: 'c_config' },
  baseServer: { c_env: 'c_config' }
}

function getConfigData(userRootDir: string, isDev: boolean, invalidate: boolean): Promise<ConfigData> {
  let force = false
  if (invalidate) {
    assert([true, false].includes(isFirstInvalidation))
    if (isFirstInvalidation) {
      isFirstInvalidation = false
    } else {
      force = true
    }
  }
  if (!configDataPromise || force) {
    configDataPromise = loadConfigData(userRootDir, isDev)
  }
  return configDataPromise
}

async function loadConfigData(userRootDir: string, isDev: boolean): Promise<ConfigData> {
  const result = await findAndLoadPageConfigFiles(userRootDir, isDev)
  /* TODO: - remove this if we don't need this for optimizeDeps.entries
   *       - also remove whole result.err try-catch mechanism, just let esbuild throw instead
  if ('err' in result) {
    return ['export const pageConfigs = null;', 'export const pageConfigGlobal = null;'].join('\n')
  }
  */
  if ('err' in result) {
    handleBuildError(result.err, isDev)
    assert(false)
  }
  const { pageConfigFiles } = result

  let configValueFiles: ConfigValueFile[]
  {
    const configDefinitionsAll = getConfigDefinitions(pageConfigFiles)
    configValueFiles = await findAndLoadConfigValueFiles(configDefinitionsAll, userRootDir, isDev)
  }

  const vikeConfig: Record<string, unknown> = {}
  let vikeConfigFilePath: string | null = null
  const pageConfigGlobal: PageConfigGlobalData = {
    onBeforeRoute: null,
    onPrerenderStart: null
  }
  {
    const pageConfigFileGlobal = getPageConfigGlobal(pageConfigFiles)
    if (pageConfigFileGlobal) {
      vikeConfigFilePath = pageConfigFileGlobal.pageConfigFilePath
    }
    pageConfigFiles.forEach((pageConfigFile) => {
      const { pageConfigFileExports, pageConfigFilePath } = pageConfigFile
      assertDefaultExportObject(pageConfigFileExports, pageConfigFilePath)
      Object.entries(pageConfigFileExports.default).forEach(([configName]) => {
        if (!isGlobal(configName)) return
        // TODO/v1: add links to docs further explaining why
        assertUsage(
          pageConfigFile === pageConfigFileGlobal,
          [
            `${pageConfigFilePath} defines the config '${configName}' which is global: `,
            pageConfigFileGlobal
              ? `define '${configName}' in ${pageConfigFileGlobal.pageConfigFilePath} instead `
              : `create a global config (e.g. /pages/+config.js) and define '${configName}' there instead`
          ].join(' ')
        )
      })
    })
    const configValueFilesRelevant = configValueFiles.filter((c) => {
      // TODO: assert that there should be only one
      // TODO: assert filesystem location
      return isGlobal(c.configName)
    })
    objectEntries(globalConfigsDefinition).forEach(([configName, configDef]) => {
      const configSource = resolveConfigSource(
        configName,
        configDef,
        pageConfigFileGlobal ? [pageConfigFileGlobal] : [],
        userRootDir,
        configValueFilesRelevant
      )
      if (!configSource) return
      if (arrayIncludes(objectKeys(pageConfigGlobal), configName)) {
        assert(!('configValue' in configSource))
        pageConfigGlobal[configName] = configSource
      } else {
        assert('configValue' in configSource)
        vikeConfig[configName] = configSource.configValue
      }
    })
  }

  const pageIds = determinePageIds(pageConfigFiles, configValueFiles)

  const pageConfigsData: PageConfigData[] = []
  pageIds.forEach(({ pageId2, routeFilesystem, pageConfigFile, routeFilesystemDefinedBy }) => {
    const pageConfigFilesRelevant = pageConfigFiles.filter(({ pageConfigFilePath }) =>
      isRelevantConfigPath(pageConfigFilePath, pageId2)
    )
    const configValueFilesRelevant = configValueFiles
      .filter(({ configValueFilePath }) => isRelevantConfigPath(configValueFilePath, pageId2))
      .filter((configValueFile) => !isGlobal(configValueFile.configName))
    let configDefinitionsRelevant = getConfigDefinitions(pageConfigFilesRelevant)

    if (pageConfigFile) {
      const pageConfigValues = getPageConfigValues(pageConfigFile)
      Object.keys(pageConfigValues).forEach((configName) => {
        // TODO: this applies only against concrete config files, we should also apply to abstract config files
        assertConfigName(
          configName,
          [...Object.keys(configDefinitionsRelevant), 'configDefinitions'],
          pageConfigFile.pageConfigFilePath
        )
      })
    }

    // TODO: remove this and instead ensure that configs are always defined globally
    configValueFilesRelevant.forEach((configValueFile) => {
      const { configName } = configValueFile
      assert(configName in configDefinitionsRelevant || configName === 'configDefinitions')
    })

    let configSources: PageConfigData['configSources'] = {}
    objectEntries(configDefinitionsRelevant).forEach(([configName, configDef]) => {
      const configSource = resolveConfigSource(
        configName,
        configDef,
        pageConfigFilesRelevant,
        userRootDir,
        configValueFilesRelevant
      )
      if (!configSource) return
      configSources[configName as ConfigName] = configSource
    })

    configSources = applySideEffects(configSources, configDefinitionsRelevant)

    const isErrorPage: boolean = !!configSources.isErrorPage?.configValue

    pageConfigsData.push({
      pageId2,
      isErrorPage,
      routeFilesystemDefinedBy,
      pageConfigFilePathAll: pageConfigFilesRelevant.map((p) => p.pageConfigFilePath),
      routeFilesystem: isErrorPage ? null : routeFilesystem,
      configSources
    })
  })

  return { pageConfigsData, pageConfigGlobal, vikeConfig, vikeConfigFilePath }
}

function determinePageIds(pageConfigFiles: PageConfigFile[], configValueFiles: ConfigValueFile[]) {
  const pageIds: {
    pageId2: string
    routeFilesystem: string
    pageConfigFile: null | PageConfigFile
    routeFilesystemDefinedBy: string
  }[] = []
  pageConfigFiles
    .filter((p) => isDefiningPage(p))
    .forEach((pageConfigFile) => {
      const { pageConfigFilePath } = pageConfigFile
      const pageId2 = determinePageId2(pageConfigFilePath)
      const routeFilesystem = determineRouteFromFilesystemPath(pageConfigFilePath)
      pageIds.push({
        pageId2,
        routeFilesystem,
        pageConfigFile,
        routeFilesystemDefinedBy: pageConfigFilePath
      })
    })
  configValueFiles.map((configValueFile) => {
    if (!isConfigDefiningPage(configValueFile.configName)) return
    const { configValueFilePath } = configValueFile
    const pageId2 = determinePageId2(configValueFilePath)
    const routeFilesystem = determineRouteFromFilesystemPath(configValueFilePath)
    assertPosixPath(configValueFilePath)
    const routeFilesystemDefinedBy = path.posix.dirname(configValueFilePath) + '/'
    assert(!routeFilesystemDefinedBy.endsWith('//'))
    {
      const alreadyIncluded = pageIds.some((p) => {
        if (p.pageId2 === pageId2) {
          assert(p.routeFilesystem === routeFilesystem)
          return true
        }
        return false
      })
      if (alreadyIncluded) return
    }
    pageIds.push({
      pageId2,
      routeFilesystem,
      pageConfigFile: null,
      routeFilesystemDefinedBy
    })
  })
  return pageIds
}

function resolveConfigSource(
  configName: string,
  configDef: ConfigDefinition,
  pageConfigFilesRelevant: PageConfigFile[],
  userRootDir: string,
  configValueFilesRelevant: ConfigValueFile[]
): null | ConfigSource {
  // TODO: implement warning if defined in non-abstract +config.js as well as in +{configName}.js

  {
    const configValueFiles = configValueFilesRelevant.filter(
      (configValueFile) => configValueFile.configName === configName
    )
    if (configValueFiles.length !== 0) {
      assert(configValueFiles.length === 1)
      const configValueFile = configValueFiles[0]!
      const { configValueFilePath } = configValueFile
      const configSource: ConfigSource = {
        c_env: configDef.c_env,
        // TODO: rename codeFilePath2 to configValueFilePath?
        codeFilePath2: configValueFilePath,
        configFilePath2: null,
        configSrc: `${configValueFilePath} > \`export default\``,
        configDefinedByFile: configValueFilePath
      }
      if ('configValue' in configValueFile) {
        configSource.configValue = configValueFile.configValue
      }
      return configSource
    }
  }

  const result = getConfigValue(configName, pageConfigFilesRelevant)
  if (!result) return null
  const { pageConfigValue, pageConfigValueFilePath } = result
  const configValue = pageConfigValue
  const configFilePath = pageConfigValueFilePath
  const { c_code, c_validate } = configDef
  const codeFilePath = getCodeFilePath(pageConfigValue, pageConfigValueFilePath, userRootDir, configName, c_code)
  assert(codeFilePath || !c_code) // TODO: assertUsage() or remove
  if (c_validate) {
    const commonArgs = { configFilePath }
    if (codeFilePath) {
      assert(typeof configValue === 'string')
      c_validate({ configValue, codeFilePath, ...commonArgs })
    } else {
      c_validate({ configValue, ...commonArgs })
    }
  }
  const { c_env } = configDef
  if (!codeFilePath) {
    return {
      configFilePath2: configFilePath,
      configSrc: `${configFilePath} > ${configName}`,
      configDefinedByFile: configFilePath,
      codeFilePath2: null,
      c_env,
      configValue
    }
  } else {
    assertUsage(
      typeof configValue === 'string',
      `${getErrorIntro(
        configFilePath,
        configName
      )} to a value with a wrong type \`${typeof configValue}\`: it should be a string instead`
    )
    return {
      configFilePath2: configFilePath,
      codeFilePath2: codeFilePath,
      configSrc: `${codeFilePath} > \`export default\``,
      configDefinedByFile: codeFilePath,
      c_env
    }
  }
}

function isDefiningPage(pageConfigFile: PageConfigFile): boolean {
  const pageConfigValues = getPageConfigValues(pageConfigFile)
  return Object.keys(pageConfigValues).some((configName) => isConfigDefiningPage(configName))
}
function isConfigDefiningPage(configName: string): boolean {
  return ['Page', 'route', 'isErrorPage'].includes(configName)
}

function getCodeFilePath(
  configValue: unknown,
  pageConfigFilePath: string,
  userRootDir: string,
  configName: string,
  enforce: undefined | boolean
): null | string {
  if (typeof configValue !== 'string') {
    assertUsage(
      !enforce,
      `${getErrorIntro(
        pageConfigFilePath,
        configName
      )} to a value with an invalid type \`${typeof configValue}\` but it should be a \`string\` instead`
    )
    return null
  }

  let codeFilePath = getVitePathFromConfigValue(toPosixPath(configValue), pageConfigFilePath)
  assertPosixPath(userRootDir)
  assertPosixPath(codeFilePath)
  codeFilePath = path.posix.join(userRootDir, codeFilePath)
  const clean = addFileExtensionsToRequireResolve()
  let fileExists: boolean
  try {
    codeFilePath = require.resolve(codeFilePath)
    fileExists = true
  } catch {
    fileExists = false
  } finally {
    clean()
  }
  codeFilePath = toPosixPath(codeFilePath)

  if (!enforce && !fileExists) return null
  assertCodeFilePathConfigValue(configValue, pageConfigFilePath, codeFilePath, fileExists, configName)

  // Make relative to userRootDir
  codeFilePath = getVitePathFromAbsolutePath(codeFilePath, userRootDir)

  assert(fileExists)
  assertPosixPath(codeFilePath)
  assert(codeFilePath.startsWith('/'))
  return codeFilePath
}

function assertCodeFilePathConfigValue(
  configValue: string,
  pageConfigFilePath: string,
  codeFilePath: string,
  fileExists: boolean,
  configName: string
) {
  const errIntro = getErrorIntro(pageConfigFilePath, configName)
  const errIntro1 = `${errIntro} to the value '${configValue}'` as const
  const errIntro2 = `${errIntro1} but the value should be` as const
  const warnArgs = { onlyOnce: true, showStackTrace: false } as const

  assertUsage(fileExists, `${errIntro1} but a file wasn't found at ${codeFilePath}`)

  let configValueFixed = configValue

  if (!isPosixPath(configValueFixed)) {
    assert(configValueFixed.includes('\\'))
    configValueFixed = toPosixPath(configValueFixed)
    assert(!configValueFixed.includes('\\'))
    assertWarning(
      false,
      `${errIntro2} '${configValueFixed}' instead (replace backslashes '\\' with forward slahes '/')`,
      warnArgs
    )
  }

  if (configValueFixed.startsWith('/')) {
    const pageConfigDir = dirnameNormalized(pageConfigFilePath)
    assertWarning(
      false,
      `${errIntro2} a relative path instead (i.e. a path that starts with './' or '../') that is relative to ${pageConfigDir}`,
      warnArgs
    )
  } else if (!['./', '../'].some((prefix) => configValueFixed.startsWith(prefix))) {
    // It isn't possible to omit '../' so we can assume that the path is relative to pageConfigDir
    configValueFixed = './' + configValueFixed
    assertWarning(
      false,
      `${errIntro2} '${configValueFixed}' instead: make sure to prefix paths with './' (or '../')`,
      warnArgs
    )
  }
  {
    const filename = path.posix.basename(codeFilePath)
    configValueFixed = dirnameNormalized(configValueFixed) + filename
    const fileExt = path.posix.extname(filename)
    assertWarning(
      configValue.endsWith(filename),
      `${errIntro2} '${configValueFixed}' instead (don't omit the file extension '${fileExt}')`,
      warnArgs
    )
  }
}

function getVitePathFromConfigValue(codeFilePath: string, pageConfigFilePath: string): string {
  const pageConfigDir = dirnameNormalized(pageConfigFilePath)
  if (!codeFilePath.startsWith('/')) {
    assertPosixPath(codeFilePath)
    assertPosixPath(pageConfigFilePath)
    codeFilePath = path.posix.join(pageConfigDir, codeFilePath)
  }
  assert(codeFilePath.startsWith('/'))
  return codeFilePath
}

function getVitePathFromAbsolutePath(filePathAbsolute: string, root: string): string {
  assertPosixPath(filePathAbsolute)
  assertPosixPath(root)
  assert(filePathAbsolute.startsWith(root))
  let vitePath = path.posix.relative(root, filePathAbsolute)
  assert(!vitePath.startsWith('/') && !vitePath.startsWith('.'))
  vitePath = '/' + vitePath
  return vitePath
}

function dirnameNormalized(filePath: string) {
  assertPosixPath(filePath)
  let fileDir = path.posix.dirname(filePath)
  assert(!fileDir.endsWith('/'))
  fileDir = fileDir + '/'
  return fileDir
}

function getErrorIntro(pageConfigFilePath: string, configName: string): string {
  assert(pageConfigFilePath.startsWith('/'))
  assert(!configName.startsWith('/'))
  return `${pageConfigFilePath} sets the config ${configName}`
}

function getConfigValue(
  pageConfigName: string,
  pageConfigFilesRelevant: PageConfigFile[]
): null | { pageConfigValueFilePath: string; pageConfigValue: unknown } {
  for (const configFile of pageConfigFilesRelevant) {
    const pageConfigValues = getPageConfigValues(configFile)
    const pageConfigValue = pageConfigValues[pageConfigName]
    if (pageConfigValue !== undefined) {
      return { pageConfigValueFilePath: configFile.pageConfigFilePath, pageConfigValue }
    }
  }
  return null
}

function getPageConfigValues(pageConfigFile: PageConfigFile): Record<string, unknown> {
  const { pageConfigFilePath, pageConfigFileExports } = pageConfigFile
  assertDefaultExportObject(pageConfigFileExports, pageConfigFilePath)
  const pageConfigValues = pageConfigFileExports.default
  return pageConfigValues
}

function getConfigDefinitions(pageConfigFilesRelevant: PageConfigFile[]): ConfigDefinitionsAll {
  const configDefinitionsAll: ConfigDefinitionsAll = { ...configDefinitionsBuiltIn }
  pageConfigFilesRelevant.forEach((pageConfigFile) => {
    const { pageConfigFilePath } = pageConfigFile
    const { configDefinitions } = getPageConfigValues(pageConfigFile)
    if (configDefinitions) {
      assertUsage(
        isObject(configDefinitions),
        `${pageConfigFilePath} sets the config 'configDefinitions' to a value with an invalid type \`${typeof configDefinitions}\`: it should be an object instead.`
      )
      objectEntries(configDefinitions).forEach(([configName, configDefinition]) => {
        assertUsage(
          isObject(configDefinition),
          `${pageConfigFilePath} sets 'configDefinitions.${configName}' to a value with an invalid type \`${typeof configDefinition}\`: it should be an object instead.`
        )

        // User can override an existing config definition
        const def = mergeConfigDefinition(
          configDefinitionsAll[configName] as ConfigDefinition | undefined,
          configDefinition as ConfigDefinition
        )

        // Validation
        /* TODO
        {
          {
            const prop = 'c_env'
            const hint = `Make sure to define the 'c_env' value of '${configName}' to 'client-only', 'server-only', or 'server-and-client'.`
            assertUsage(
              prop in def,
              `${pageConfigFilePath} doesn't define 'configDefinitions.${configName}.c_env' which is required. ${hint}`
            )
            assertUsage(
              hasProp(def, prop, 'string'),
              `${pageConfigFilePath} sets 'configDefinitions.${configName}.c_env' to a value with an invalid type ${typeof def.c_env}. ${hint}`
            )
            assertUsage(
              ['client-only', 'server-only', 'server-and-client'].includes(def.c_env),
              `${pageConfigFilePath} sets 'configDefinitions.${configName}.c_env' to an invalid value '${def.c_env}'. ${hint}`
            )
          }
        }
        */

        configDefinitionsAll[configName] = def /* TODO: validate instead */ as any
      })
    }
  })
  return configDefinitionsAll
}

//function mergeConfigDefinition(def: ConfigDefinition, mods: Partial<ConfigDefinition>): ConfigDefinition
function mergeConfigDefinition(
  def: ConfigDefinition | undefined,
  mods: Partial<ConfigDefinition>
): Partial<ConfigDefinition>
function mergeConfigDefinition(
  def: ConfigDefinition | undefined,
  mods: Partial<ConfigDefinition>
): Partial<ConfigDefinition> {
  return {
    ...def,
    ...mods
  }
}

type ConfigSources = Record<string, ConfigSource>

function applySideEffects(
  configSources: ConfigSources,
  configDefinitionsRelevant: ConfigDefinitionsAll
): ConfigSources {
  const configSourcesMod = { ...configSources }

  objectEntries(configDefinitionsRelevant).forEach(([configName, configDef]) => {
    if (!configDef.sideEffect) return
    assertUsage(configDef.c_env === 'c_config', 'TODO')
    const configSourceSideEffect = configSources[configName]
    /*
    resolveConfigSource(
      configName,
      configDef,
      pageConfigFilesRelevant,
      userRootDir,
      configValueFilesRelevant
    )
    */
    if (!configSourceSideEffect) return
    assert('configValue' in configSourceSideEffect)
    const { configValue, configDefinedByFile } = configSourceSideEffect
    const configMod = configDef.sideEffect({
      configValue,
      configDefinedBy: configDefinedByFile // TODO: align naming
    })
    if (!configMod) return
    objectEntries(configMod).forEach(([configName, configModValue]) => {
      if (configName === 'configDefinitions') {
        assertUsage(isObject(configModValue), 'TODO')
        objectEntries(configModValue).forEach(([configTargetName, configTargetModValue]) => {
          assertUsage(isObject(configTargetModValue), 'TODO')
          assertUsage(Object.keys(configTargetModValue).length === 1, 'TODO')
          assertUsage(hasProp(configTargetModValue, 'c_env', 'string'), 'TODO')
          const c_env = configTargetModValue.c_env as c_Env // TODO: proper validation
          configSourcesMod[configTargetName]!.c_env = c_env
        })
      } else {
        assertConfigName(configName, Object.keys(configDefinitionsRelevant), `sideEffect of TODO`)
        const configSourceTargetOld = configSourcesMod[configName]
        assert(configSourceTargetOld)
        configSourcesMod[configName] = {
          // TODO-begin
          ...configSourceSideEffect,
          configSrc: `${configSourceSideEffect} (side-effect)`,
          // TODO-end
          c_env: configSourceTargetOld.c_env,
          configValue: configModValue
        }
      }
    })
  })

  return configSourcesMod
}

type PageConfigFile = {
  pageConfigFilePath: string
  pageConfigFileExports: Record<string, unknown>
}

type ConfigValueFile = {
  // TODO:
  // rename determinePageId2(), and rename pageId to configId or remove pageId (instead use determinePageId2)
  pageId: string
  configName: string
  configValueFilePath: string
  configValue?: unknown
}
async function findAndLoadConfigValueFiles(
  configDefinitionsAll: ConfigDefinitionsAll,
  userRootDir: string,
  isDev: boolean
): Promise<ConfigValueFile[]> {
  const found = await findUserFiles('**/+*', userRootDir, isDev)
  const configValueFiles: ConfigValueFile[] = await Promise.all(
    found
      .filter((f) => extractConfigName(f.filePathRelativeToUserRootDir) !== 'config')
      .map(async ({ filePathAbsolute, filePathRelativeToUserRootDir }) => {
        const configName = extractConfigName(filePathRelativeToUserRootDir)
        assertConfigName(
          configName,
          [...Object.keys(configDefinitionsAll), ...Object.keys(globalConfigsDefinition)],
          filePathRelativeToUserRootDir
        )
        const configDef =
          configDefinitionsAll[configName] ?? (globalConfigsDefinition as Record<string, ConfigDefinition>)[configName]
        assert(configDef)
        const configValueFile: ConfigValueFile = {
          configName,
          pageId: determinePageId2(filePathRelativeToUserRootDir),
          configValueFilePath: filePathRelativeToUserRootDir
        }
        if (configDef.c_env !== 'c_config') {
          return configValueFile
        }
        const result = await transpileAndLoadScriptFile(filePathAbsolute)
        if ('err' in result) {
          throw result.err
        }
        const fileExports = result.exports
        assertDefaultExport(fileExports, filePathRelativeToUserRootDir)
        const configValue = fileExports.default
        objectAssign(configValueFile, { configValue })
        return configValueFile
      })
  )
  return configValueFiles
}

function extractConfigName(filePath: string) {
  assertPosixPath(filePath)
  const basename = path.posix.basename(filePath).split('.')[0]!
  assert(basename.startsWith('+'))
  const configName = basename.slice(1)
  return configName
}

async function findAndLoadPageConfigFiles(
  userRootDir: string,
  isDev: boolean
): Promise<{ err: unknown } | { pageConfigFiles: PageConfigFile[] }> {
  const pageConfigFilePaths = await findUserFiles(`**/+config.${scriptFileExtensions}`, userRootDir, isDev)

  const pageConfigFiles: PageConfigFile[] = []
  // TODO: make esbuild build everyting at once
  const results = await Promise.all(
    pageConfigFilePaths.map(async ({ filePathAbsolute, filePathRelativeToUserRootDir }) => {
      const result = await transpileAndLoadScriptFile(filePathAbsolute)
      if ('err' in result) {
        return { err: result.err }
      }
      return { pageConfigFilePath: filePathRelativeToUserRootDir, pageConfigFileExports: result.exports }
    })
  )
  for (const result of results) {
    if ('err' in result) {
      assert(result.err)
      return {
        err: result.err
      }
    }
  }
  results.forEach((result) => {
    assert(!('err' in result))
    const { pageConfigFilePath, pageConfigFileExports } = result
    pageConfigFiles.push({
      pageConfigFilePath,
      pageConfigFileExports
    })
  })

  return { pageConfigFiles }
}

async function findUserFiles(pattern: string | string[], userRootDir: string, isDev: boolean) {
  assertPosixPath(userRootDir)
  const timeBase = new Date().getTime()
  const result = await glob(pattern, {
    ignore: ['**/node_modules/**'],
    cwd: userRootDir,
    dot: false
  })
  const time = new Date().getTime() - timeBase
  if (isDev) {
    // We only warn in dev, because while building it's expected to take a long time as fast-glob is competing for resources with other tasks
    assertWarning(
      time < 2 * 1000,
      `Crawling your user files took an unexpected long time (${time}ms). Create a new issue on vite-plugin-ssr's GitHub.`,
      {
        showStackTrace: false,
        onlyOnce: 'slow-page-files-search'
      }
    )
  }
  const userFiles = result.map((p) => {
    p = toPosixPath(p)
    const filePathRelativeToUserRootDir = path.posix.join('/', p)
    const filePathAbsolute = path.posix.join(userRootDir, p)
    return { filePathRelativeToUserRootDir, filePathAbsolute }
  })
  return userFiles
}

function handleBuildError(err: unknown, isDev: boolean) {
  // Properly handle error during transpilation so that we can use assertUsage() during transpilation
  if (isDev) {
    throw err
  } else {
    // Avoid ugly error format:
    // ```
    // [vite-plugin-ssr:importUserCode] Could not load virtual:vite-plugin-ssr:importUserCode:server: [vite-plugin-ssr@0.4.70][Wrong Usage] /pages/+config.ts sets the config 'onRenderHtml' to the value './+config/onRenderHtml-i-dont-exist.js' but no file was found at /home/rom/code/vite-plugin-ssr/examples/v1/pages/+config/onRenderHtml-i-dont-exist.js
    // Error: [vite-plugin-ssr@0.4.70][Wrong Usage] /pages/+config.ts sets the config 'onRenderHtml' to the value './+config/onRenderHtml-i-dont-exist.js' but no file was found at /home/rom/code/vite-plugin-ssr/examples/v1/pages/+config/onRenderHtml-i-dont-exist.js
    //     at ...
    //     at ...
    //     at ...
    //     at ...
    //     at ...
    //     at ...
    //   code: 'PLUGIN_ERROR',
    //   plugin: 'vite-plugin-ssr:importUserCode',
    //   hook: 'load',
    //   watchFiles: [
    //     '/home/rom/code/vite-plugin-ssr/vite-plugin-ssr/dist/cjs/node/importBuild.js',
    //     '\x00virtual:vite-plugin-ssr:importUserCode:server'
    //   ]
    // }
    //  ELIFECYCLE  Command failed with exit code 1.
    // ```
    console.log('')
    console.error(err)
    process.exit(1)
  }
}

function isRelevantConfigPath(
  configPath: string, // Can be pageConfigFilePath or configValueFilePath
  pageId: string
): boolean {
  const configFsRoot = removeDir(removeFilename(configPath), ['renderer', 'pages'])
  const isRelevant = removeDir(pageId, ['pages']).startsWith(configFsRoot)
  return isRelevant
}
function removeFilename(configPath: string) {
  assertPosixPath(configPath)
  assert(configPath.startsWith('/'))
  const filename = configPath.split('/').slice(-1)[0]!
  assert(filename.includes('.'))
  assert(filename.startsWith('+'))
  return configPath.split('/').slice(0, -1).join('/')
}
function removeDir(fsPath: string, dirs: string[]) {
  assertPosixPath(fsPath)
  assert(fsPath.startsWith('/'))
  return fsPath
    .split('/')
    .filter((p) => !dirs.includes(p))
    .join('/')
}

function getPageConfigGlobal(pageConfigFiles: PageConfigFile[]): null | PageConfigFile {
  if (pageConfigFiles.length === 0) return null
  let candidate: PageConfigFile = pageConfigFiles[0]!
  pageConfigFiles.forEach((p) => {
    if (dir(p.pageConfigFilePath).length < dir(candidate.pageConfigFilePath).length) {
      candidate = p
    }
  })
  if (pageConfigFiles.some((p) => !dir(p.pageConfigFilePath).startsWith(dir(candidate.pageConfigFilePath)))) {
    return null
  } else {
    const pageConfigGlobal = candidate
    return pageConfigGlobal
  }
}
function dir(filePath: string) {
  assertPosixPath(filePath)
  return path.posix.dirname(filePath)
}

function isGlobal(configName: string): configName is GlobalConfigName {
  const configNamesGlobal = Object.keys(globalConfigsDefinition)
  return arrayIncludes(configNamesGlobal, configName)
}

function assertConfigName(configName: string, configNames: string[], definedBy: string) {
  if (configNames.includes(configName)) return
  let errMsg = `${definedBy} defines an unknown config '${configName}'`
  const configNameSimilar = getMostSimilar(configName, configNames)
  if (configNameSimilar) {
    assert(configNameSimilar !== configName)
    errMsg = `${errMsg}, did you mean to define '${configNameSimilar}' instead?`
  }
  assertUsage(false, errMsg)
}
