/**
 * Local source-directory developer mode (EXT-06's optional fourth source).
 *
 * A source DIRECTORY is treated as a package source with the SAME discipline
 * as archives: the operator configuration must explicitly allow it, the path's
 * ancestor chain is reparse-point-checked, the tree is COPIED (a source
 * checkout is mutable and must not become a live installation), reparse points
 * INSIDE the tree are refused, the manifest is validated exactly like a packed
 * package, install-time lifecycle scripts are refused (never run), and the
 * installation lands INACTIVE with its source recorded. It is developer mode,
 * not a production release path (EXT-06: "Optional developer mode only").
 *
 * @module @try-works/tool-mode-extension-sdk/install/source-directory
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { ManagementError } from './../errors.ts'
import { discoverExtension, type ExtensionDiscovery } from './../discovery.ts'
import { digestInstalledContent, ExtensionStore } from './store.ts'
import { installPathFor, type InstallPreview, type InstallProvenance, type StagedInstallResult } from './staged.ts'
import { installDependencyGraph, refuseInstallScripts, type InstallDependencyGraph } from './dependencies.ts'
import { linkRuntimeSdk, RUNTIME_SDK_NAME } from './runtime-link.ts'

/** The dev-mode bounds for one directory copy. */
const MAX_DIRECTORY_FILES = 10_000
const MAX_DIRECTORY_BYTES = 512 * 1024 * 1024

/** Refuse a reparse point anywhere on the source directory's ancestor chain. */
function ancestorRefusal(target: string): string | undefined {
  const absolute = resolve(target)
  const root = parse(absolute).root
  const components = absolute.slice(root.length).split(sep).filter(Boolean)
  let cursor = root
  for (const component of components) {
    cursor = join(cursor, component)
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        return `the source directory passes through a symbolic link or junction at ${cursor}; developer-mode installs refuse reparse points`
      }
    } catch {
      break
    }
  }
  return undefined
}

/** Copy one directory tree, refusing reparse points and bounding the copy. */
function copyTree(source: string, destination: string, budget: { files: number; bytes: number }): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isSymbolicLink() || entry.isFile() === false && entry.isDirectory() === false) {
      // Windows junctions appear as symlinks via dirent in modern Node;
      // anything that is neither a plain file nor a directory is refused.
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `${from} is a reparse point; a source checkout must not smuggle links into the installation`,
        'Remove the link or copy the referenced content explicitly; the installer never follows it.',
      )
    }
    if (entry.isDirectory()) {
      copyTree(from, to, budget)
      continue
    }
    const stat = lstatSync(from)
    budget.files += 1
    budget.bytes += stat.size
    if (budget.files > MAX_DIRECTORY_FILES || budget.bytes > MAX_DIRECTORY_BYTES) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the source directory exceeds the developer-mode bounds (${MAX_DIRECTORY_FILES} files / ${MAX_DIRECTORY_BYTES} bytes)`,
        'Reduce the checkout or pack it into an archive.',
      )
    }
    copyFileSync(from, to)
  }
}

/**
 * Install a local source directory in developer mode (EXT-06).
 *
 * @param options - the directory, the store, the operator allow-gate, and the
 *   same preview/dependency/provenance options the archive path takes.
 * @returns the installed (INACTIVE) extension.
 * @throws ManagementError for every rejection path.
 */
export async function stagedInstallFromDirectory(options: {
  readonly sourceDir: string
  readonly storeDir: string
  /** The operator config gate: source directories install ONLY when explicitly allowed. */
  readonly allowSourceDirectories: boolean
  readonly preview?: (preview: InstallPreview) => void | Promise<void>
  readonly dependencies?: InstallDependencyGraph
  readonly provenance?: InstallProvenance
  readonly record?: boolean
}): Promise<StagedInstallResult> {
  if (!options.allowSourceDirectories) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      'source-directory installs are not allowed by the operator configuration',
      'Enable the developer-mode source-directory source deliberately, or pack the directory into an archive.',
    )
  }
  const source = resolve(options.sourceDir)
  if (!existsSync(source)) {
    throw new ManagementError('INVALID_EXTENSION', 'install', `the source directory ${source} does not exist`, 'Point at an existing checkout.')
  }
  const chainRefusal = ancestorRefusal(source)
  if (chainRefusal !== undefined) {
    throw new ManagementError('INVALID_EXTENSION', 'install', chainRefusal, 'Use a path free of junctions and symlinks.')
  }

  const storeDir = resolve(options.storeDir)
  const staging = join(storeDir, '.staging')
  const attempt = join(staging, `source-${process.pid}-${Date.now().toString(36)}`)
  mkdirSync(attempt, { recursive: true })
  try {
    copyTree(source, attempt, { files: 0, bytes: 0 })
    const discovery: ExtensionDiscovery = discoverExtension(attempt)
    // Install-time lifecycle scripts are refused, never run (EXT-10).
    refuseInstallScripts(attempt, discovery.packageName, discovery.packageVersion)

    let lockedDependencies: readonly import('./dependencies.ts').LockedDependency[] = []
    let declared = 0
    try {
      declared = Object.keys((JSON.parse(readFileSync(join(attempt, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }).dependencies ?? {}).length
    } catch {
      // Discovery already read package.json.
    }
    if (declared > 0) {
      if (options.dependencies === undefined) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `${discovery.packageName} declares ${declared} runtime dependenc${declared === 1 ? 'y' : 'ies'} but no dependency-graph installer was provided`,
          'Provide the operator-configured registry resolver, or bundle the dependencies.',
        )
      }
      lockedDependencies = await installDependencyGraph(attempt, options.dependencies)
    }

    if (options.preview !== undefined) {
      const manifest = discovery.manifest
      await options.preview({
        extensionId: discovery.packageName,
        version: discovery.packageVersion,
        permissions: manifest.permissions,
        models: manifest.models.map(model => ({
          id: model.id,
          assetSet: model.assetSet,
          platforms: model.platforms.map(platform => `${platform.os}-${platform.arch}${platform.accelerator === undefined ? '' : `-${platform.accelerator}`}`),
        })),
        licenses: (manifest.licenses ?? []).map(layer => `${layer.layer}: ${layer.name}`),
        downloadImplications: 'developer-mode directory source: nothing is downloaded; the checkout was copied and verified',
        requiresApproval: false,
      })
    }

    const destination = installPathFor(storeDir, discovery.packageName, discovery.packageVersion)
    if (existsSync(destination)) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `${discovery.packageName}@${discovery.packageVersion} is already installed`,
        'Install a different version, or uninstall the existing one first.',
      )
    }
    mkdirSync(join(destination, '..'), { recursive: true })
    renameSync(attempt, destination)
    const runtimeLinkDiagnostic = linkRuntimeSdk(destination)
    if (runtimeLinkDiagnostic.reason === 'sdk-shadowed') {
      rmSync(destination, { recursive: true, force: true })
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        runtimeLinkDiagnostic.detail ?? 'the package ships its own copy of the host runtime SDK',
        'Remove node_modules/' + RUNTIME_SDK_NAME + ' from the checkout.',
      )
    }
    const contentDigest = digestInstalledContent(destination)
    writeFileSync(join(destination, '.tool-mode-install.json'), `${JSON.stringify({
      extensionId: discovery.packageName,
      version: discovery.packageVersion,
      archiveDigest: contentDigest, // a directory has no archive; the content digest is the identity
      ...runtimeLinkDiagnostic === undefined ? {} : { runtimeLink: runtimeLinkDiagnostic },
      source: { kind: 'local-directory', requested: source },
      ...lockedDependencies.length === 0 ? {} : { dependencies: lockedDependencies },
      ...options.provenance === undefined ? {} : { provenance: options.provenance },
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`)
    if (options.record !== false) {
      const store = new ExtensionStore(storeDir)
      store.recordInstall({
        extensionId: discovery.packageName,
        version: discovery.packageVersion,
        installPath: destination,
        archiveDigest: contentDigest,
        ...runtimeLinkDiagnostic === undefined ? {} : { runtimeLink: runtimeLinkDiagnostic },
        contentDigest,
        source: { kind: 'local-directory', requested: source },
        ...lockedDependencies.length === 0 ? {} : { dependencies: lockedDependencies },
        ...options.provenance === undefined ? {} : { provenance: options.provenance },
        installedAt: new Date().toISOString(),
      })
    }
    return {
      extensionId: discovery.packageName,
      version: discovery.packageVersion,
      installPath: destination,
      activation: 'inactive',
      discovery,
      archiveDigest: contentDigest,
      ...runtimeLinkDiagnostic === undefined ? {} : { runtimeLink: runtimeLinkDiagnostic },
    }
  } finally {
    rmSync(attempt, { recursive: true, force: true })
  }
}
