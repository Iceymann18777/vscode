/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel } from 'vs/base/parts/ipc/common/ipc';
import { IExtensionManagementService, ILocalExtension, IGalleryExtension, IExtensionGalleryService, InstallOperation, InstallOptions, InstallVSIXOptions } from 'vs/platform/extensionManagement/common/extensionManagement';
import { URI } from 'vs/base/common/uri';
import { ExtensionType, IExtensionManifest } from 'vs/platform/extensions/common/extensions';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { ILogService } from 'vs/platform/log/common/log';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { isNonEmptyArray } from 'vs/base/common/arrays';
import { CancellationToken } from 'vs/base/common/cancellation';
import { localize } from 'vs/nls';
import { IProductService } from 'vs/platform/product/common/productService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { generateUuid } from 'vs/base/common/uuid';
import { joinPath } from 'vs/base/common/resources';
import { WebRemoteExtensionManagementService } from 'vs/workbench/services/extensionManagement/common/remoteExtensionManagementService';
import { IExtensionManagementServer } from 'vs/workbench/services/extensionManagement/common/extensionManagement';
import { INativeWorkbenchEnvironmentService } from 'vs/workbench/services/environment/electron-sandbox/environmentService';
import { Promises } from 'vs/base/common/async';
import { IExtensionManifestPropertiesService } from 'vs/workbench/services/extensions/common/extensionManifestPropertiesService';

export class NativeRemoteExtensionManagementService extends WebRemoteExtensionManagementService implements IExtensionManagementService {

	private readonly localExtensionManagementService: IExtensionManagementService;

	constructor(
		channel: IChannel,
		localExtensionManagementServer: IExtensionManagementServer,
		@ILogService private readonly logService: ILogService,
		@IExtensionGalleryService galleryService: IExtensionGalleryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IProductService productService: IProductService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IExtensionManifestPropertiesService extensionManifestPropertiesService: IExtensionManifestPropertiesService,
	) {
		super(channel, galleryService, configurationService, productService, extensionManifestPropertiesService);
		this.localExtensionManagementService = localExtensionManagementServer.extensionManagementService;
	}

	override async install(vsix: URI, options?: InstallVSIXOptions): Promise<ILocalExtension> {
		const local = await super.install(vsix, options);
		await this.installUIDependenciesAndPackedExtensions(local);
		return local;
	}

	override async installFromGallery(extension: IGalleryExtension, installOptions?: InstallOptions): Promise<ILocalExtension> {
		const local = await this.doInstallFromGallery(extension, installOptions);
		await this.installUIDependenciesAndPackedExtensions(local);
		return local;
	}

	private async doInstallFromGallery(extension: IGalleryExtension, installOptions?: InstallOptions): Promise<ILocalExtension> {
		if (this.configurationService.getValue('remote.downloadExtensionsLocally')) {
			return this.downloadAndInstall(extension, installOptions || {});
		}
		try {
			return await super.installFromGallery(extension, installOptions);
		} catch (error) {
			try {
				this.logService.error(`Error while installing '${extension.identifier.id}' extension in the remote server.`, toErrorMessage(error));
				return await this.downloadAndInstall(extension, installOptions || {});
			} catch (e) {
				this.logService.error(e);
				throw error;
			}
		}
	}

	private async downloadAndInstall(extension: IGalleryExtension, installOptions: InstallOptions): Promise<ILocalExtension> {
		this.logService.info(`Downloading the '${extension.identifier.id}' extension locally and install`);
		installOptions = { ...installOptions, donotIncludePackAndDependencies: true };
		const installed = await this.getInstalled(ExtensionType.User);
		const workspaceExtensions = await this.getAllWorkspaceDependenciesAndPackedExtensions(extension, CancellationToken.None);
		if (workspaceExtensions.length) {
			this.logService.info(`Downloading the workspace dependencies and packed extensions of '${extension.identifier.id}' locally and install`);
			for (const workspaceExtension of workspaceExtensions) {
				await this.downloadCompatibleAndInstall(workspaceExtension, installed, installOptions);
			}
		}
		return await this.downloadCompatibleAndInstall(extension, installed, installOptions);
	}

	private async downloadCompatibleAndInstall(extension: IGalleryExtension, installed: ILocalExtension[], installOptions: InstallOptions): Promise<ILocalExtension> {
		const compatible = await this.galleryService.getCompatibleExtension(extension);
		if (!compatible) {
			return Promise.reject(new Error(localize('incompatible', "Unable to install extension '{0}' as it is not compatible with VS Code '{1}'.", extension.identifier.id, this.productService.version)));
		}
		const location = joinPath(this.environmentService.tmpDir, generateUuid());
		this.logService.info('Downloaded extension:', compatible.identifier.id, location.path);
		await this.galleryService.download(compatible, location, installed.filter(i => areSameExtensions(i.identifier, compatible.identifier))[0] ? InstallOperation.Update : InstallOperation.Install);
		const local = await super.install(location, installOptions);
		this.logService.info(`Successfully installed '${compatible.identifier.id}' extension`);
		return local;
	}

	private async installUIDependenciesAndPackedExtensions(local: ILocalExtension): Promise<void> {
		const uiExtensions = await this.getAllUIDependenciesAndPackedExtensions(local.manifest, CancellationToken.None);
		const installed = await this.localExtensionManagementService.getInstalled();
		const toInstall = uiExtensions.filter(e => installed.every(i => !areSameExtensions(i.identifier, e.identifier)));
		if (toInstall.length) {
			this.logService.info(`Installing UI dependencies and packed extensions of '${local.identifier.id}' locally`);
			await Promises.settled(toInstall.map(d => this.localExtensionManagementService.installFromGallery(d)));
		}
	}

	private async getAllUIDependenciesAndPackedExtensions(manifest: IExtensionManifest, token: CancellationToken): Promise<IGalleryExtension[]> {
		const result = new Map<string, IGalleryExtension>();
		const extensions = [...(manifest.extensionPack || []), ...(manifest.extensionDependencies || [])];
		await this.getDependenciesAndPackedExtensionsRecursively(extensions, result, true, token);
		return [...result.values()];
	}

	private async getAllWorkspaceDependenciesAndPackedExtensions(extension: IGalleryExtension, token: CancellationToken): Promise<IGalleryExtension[]> {
		const result = new Map<string, IGalleryExtension>();
		result.set(extension.identifier.id.toLowerCase(), extension);
		const manifest = await this.galleryService.getManifest(extension, token);
		if (manifest) {
			const extensions = [...(manifest.extensionPack || []), ...(manifest.extensionDependencies || [])];
			await this.getDependenciesAndPackedExtensionsRecursively(extensions, result, false, token);
		}
		result.delete(extension.identifier.id);
		return [...result.values()];
	}

	private async getDependenciesAndPackedExtensionsRecursively(toGet: string[], result: Map<string, IGalleryExtension>, uiExtension: boolean, token: CancellationToken): Promise<void> {
		if (toGet.length === 0) {
			return Promise.resolve();
		}

		const extensions = await this.galleryService.getExtensions(toGet, token);
		const manifests = await Promise.all(extensions.map(e => this.galleryService.getManifest(e, token)));
		const extensionsManifests: IExtensionManifest[] = [];
		for (let idx = 0; idx < extensions.length; idx++) {
			const extension = extensions[idx];
			const manifest = manifests[idx];
			if (manifest && this.extensionManifestPropertiesService.prefersExecuteOnUI(manifest) === uiExtension) {
				result.set(extension.identifier.id.toLowerCase(), extension);
				extensionsManifests.push(manifest);
			}
		}
		toGet = [];
		for (const extensionManifest of extensionsManifests) {
			if (isNonEmptyArray(extensionManifest.extensionDependencies)) {
				for (const id of extensionManifest.extensionDependencies) {
					if (!result.has(id.toLowerCase())) {
						toGet.push(id);
					}
				}
			}
			if (isNonEmptyArray(extensionManifest.extensionPack)) {
				for (const id of extensionManifest.extensionPack) {
					if (!result.has(id.toLowerCase())) {
						toGet.push(id);
					}
				}
			}
		}
		return this.getDependenciesAndPackedExtensionsRecursively(toGet, result, uiExtension, token);
	}
}
