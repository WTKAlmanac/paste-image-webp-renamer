"use strict";

const { ButtonComponent, Modal, Notice, Plugin, TFile, normalizePath } = require("obsidian");

const MAX_IMAGE_SIZE_BYTES = 1024 * 1024;
const WEBP_QUALITY = 0.92;
const CRC32_TABLE = buildCrc32Table();

module.exports = class PasteImageWebpRenamerPlugin extends Plugin {
	async onload() {
		this.registerEvent(
			this.app.workspace.on("editor-paste", async (evt, editor, view) => {
				const clipboardData = evt.clipboardData;
				if (!clipboardData) {
					return;
				}

				const imageFiles = Array.from(clipboardData.files || []).filter((file) =>
					typeof file.type === "string" && file.type.startsWith("image/")
				);

				if (imageFiles.length === 0) {
					return;
				}

				const noteFile = view && view.file;
				if (!noteFile) {
					new Notice("未找到当前笔记，无法保存图片。");
					return;
				}

				evt.preventDefault();
				evt.stopPropagation();

				const embeds = [];

				for (const imageFile of imageFiles) {
					try {
						const embed = await this.handlePastedImage(imageFile, noteFile.path);
						if (embed) {
							embeds.push(embed);
						}
					} catch (error) {
						console.error("Failed to process pasted image", error);
						new Notice(`处理粘贴图片失败：${getErrorMessage(error)}`, 8000);
					}
				}

				if (embeds.length > 0) {
					editor.replaceSelection(embeds.join("\n"));
				}
			})
		);
	}

	async handlePastedImage(imageFile, notePath) {
		let webpBlob = await convertBlobToWebp(imageFile, WEBP_QUALITY, 100);
		if (webpBlob.size > MAX_IMAGE_SIZE_BYTES / 2) {
			webpBlob = await promptForCompressedImage(this.app, imageFile, webpBlob.size);
		}

		if (!webpBlob) {
			return null;
		}

		const webpBuffer = await webpBlob.arrayBuffer();
		const crcHex = crc32Hex(webpBuffer);
		const noteStem = sanitizeFileName(stripMarkdownExtension(notePath).replace(/[\\/]/g, "-"));
		const preferredFileName = `${noteStem}-${crcHex}.webp`;
		const targetPath = await resolveAttachmentFilePath(this.app.fileManager, preferredFileName, notePath);
		const existingFile = this.app.vault.getAbstractFileByPath(targetPath);
		if (existingFile instanceof TFile) {
			return this.buildImageEmbed(existingFile, notePath);
		}

		await ensureParentFolderExists(this.app.vault, targetPath);
		const createdFile = await this.app.vault.createBinary(targetPath, webpBuffer);

		return this.buildImageEmbed(createdFile, notePath);
	}

	buildImageEmbed(file, notePath) {
		const useMarkdownLinks =
			typeof this.app.vault.getConfig === "function" && this.app.vault.getConfig("useMarkdownLinks");
		if (useMarkdownLinks && typeof this.app.fileManager.generateMarkdownLink === "function") {
			return `!${this.app.fileManager.generateMarkdownLink(file, notePath)}`;
		}

		return `![[${file.path}]]`;
	}
};

function stripMarkdownExtension(path) {
	return path.replace(/\.md$/i, "");
}

function sanitizeFileName(value) {
	return value
		.replace(/[<>:"/\\|?*]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
}

async function resolveAttachmentFilePath(fileManager, preferredFileName, notePath) {
	const probeName = "__paste-image-webp-renamer-probe__.tmp";
	const probePath = normalizePath(await fileManager.getAvailablePathForAttachment(probeName, notePath));
	const lastSlashIndex = probePath.lastIndexOf("/");

	if (lastSlashIndex === -1) {
		return preferredFileName;
	}

	return `${probePath.slice(0, lastSlashIndex)}/${preferredFileName}`;
}

async function ensureParentFolderExists(vault, filePath) {
	const normalizedPath = normalizePath(filePath);
	const lastSlashIndex = normalizedPath.lastIndexOf("/");
	if (lastSlashIndex === -1) {
		return;
	}

	const folderPath = normalizedPath.slice(0, lastSlashIndex);
	if (!folderPath) {
		return;
	}

	const segments = folderPath.split("/");
	let currentPath = "";

	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		if (!vault.getAbstractFileByPath(currentPath)) {
			await vault.createFolder(currentPath);
		}
	}
}

async function convertBlobToWebp(blob, quality, scalePercent = 100) {
	const canvas = document.createElement("canvas");
	const imageSource = await loadImageSource(blob);

	try {
		const width = imageSource.naturalWidth || imageSource.width;
		const height = imageSource.naturalHeight || imageSource.height;
		if (!width || !height) {
			throw new Error("Decoded image has invalid dimensions.");
		}

		const scaledWidth = Math.max(1, Math.round((width * scalePercent) / 100));
		const scaledHeight = Math.max(1, Math.round((height * scalePercent) / 100));
		canvas.width = scaledWidth;
		canvas.height = scaledHeight;

		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Canvas 2D context is unavailable.");
		}

		context.drawImage(imageSource, 0, 0, scaledWidth, scaledHeight);

		const webpBlob = await new Promise((resolve, reject) => {
			canvas.toBlob(
				(result) => {
					if (!result) {
						reject(new Error("Canvas failed to encode WebP."));
						return;
					}
					resolve(result);
				},
				"image/webp",
				quality
			);
		});

		return webpBlob;
	} finally {
		if (typeof imageSource.close === "function") {
			imageSource.close();
		}
	}
}

async function promptForCompressedImage(app, imageFile, initialSizeBytes) {
	const dimensions = await getImageDimensions(imageFile);
	const modal = new ImageResizeModal(app, imageFile, initialSizeBytes, dimensions);
	return modal.openAndGetResult();
}

class ImageResizeModal extends Modal {
	constructor(app, imageFile, initialSizeBytes, dimensions) {
		super(app);
		this.imageFile = imageFile;
		this.initialSizeBytes = initialSizeBytes;
		this.dimensions = dimensions;
		this.result = null;
		this.resolveResult = null;
		this.currentScale = 100;
		this.currentBlob = null;
		this.previewToken = 0;
		this.previewReady = false;
	}

	openAndGetResult() {
		return new Promise((resolve) => {
			this.resolveResult = resolve;
			this.open();
		});
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("图片过大");

		contentEl.createEl("p", {
			text: `转换后图片大小为 ${formatBytes(this.initialSizeBytes)}，超过 1 MB。`
		});
		contentEl.createEl("p", {
			text: "请调整缩放百分比，当预览结果小于 1 MB 后再确认粘贴。"
		});

		const controlsEl = contentEl.createDiv({ cls: "paste-image-webp-renamer-controls" });
		const sliderEl = controlsEl.createEl("input", {
			type: "range",
			attr: { min: "1", max: "100", step: "1" }
		});
		sliderEl.value = "100";

		const numberEl = controlsEl.createEl("input", {
			type: "number",
			attr: { min: "1", max: "100", step: "1" }
		});
		numberEl.value = "100";

		const statusEl = contentEl.createDiv();
		statusEl.createEl("strong", { text: "正在计算可用缩放比例..." });

		const actionsEl = contentEl.createDiv({ cls: "modal-button-container" });
		const confirmButton = new ButtonComponent(actionsEl);
		confirmButton.setButtonText("确认粘贴");
		confirmButton.setCta();
		confirmButton.setDisabled(true);

		const cancelButton = new ButtonComponent(actionsEl);
		cancelButton.setButtonText("取消");

		const applyScale = debounce(async (rawValue) => {
			const scale = clampScale(rawValue);
			sliderEl.value = String(scale);
			numberEl.value = String(scale);
			await this.updatePreview(scale, statusEl, confirmButton);
		}, 150);

		sliderEl.addEventListener("input", () => {
			void applyScale(sliderEl.value);
		});
		numberEl.addEventListener("input", () => {
			void applyScale(numberEl.value);
		});

		confirmButton.onClick(() => {
			if (!this.previewReady || !this.currentBlob || this.currentBlob.size > MAX_IMAGE_SIZE_BYTES) {
				return;
			}

			this.result = this.currentBlob;
			this.close();
		});

		cancelButton.onClick(() => {
			this.result = null;
			this.close();
		});

		await this.findSuggestedScale(sliderEl, numberEl, statusEl, confirmButton);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();

		if (this.resolveResult) {
			this.resolveResult(this.result);
			this.resolveResult = null;
		}
	}

	async findSuggestedScale(sliderEl, numberEl, statusEl, confirmButton) {
		let low = 1;
		let high = 100;
		let bestScale = 0;
		let bestBlob = null;

		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const blob = await convertBlobToWebp(this.imageFile, WEBP_QUALITY, mid);

			if (blob.size <= MAX_IMAGE_SIZE_BYTES) {
				bestScale = mid;
				bestBlob = blob;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		if (!bestBlob) {
			statusEl.empty();
			statusEl.createEl("strong", {
				text: "即使缩放到 1% 仍超过 1 MB，无法自动压缩到目标大小。"
			});
			this.previewReady = false;
			confirmButton.setDisabled(true);
			return;
		}

		this.currentBlob = bestBlob;
		this.currentScale = bestScale;
		this.previewReady = true;
		sliderEl.value = String(bestScale);
		numberEl.value = String(bestScale);
		renderPreviewStatus(statusEl, bestScale, bestBlob.size, true, this.dimensions);
		confirmButton.setDisabled(false);
	}

	async updatePreview(scale, statusEl, confirmButton) {
		this.previewReady = false;
		confirmButton.setDisabled(true);
		statusEl.empty();
		statusEl.createEl("strong", { text: "正在重新计算大小..." });

		const token = ++this.previewToken;
		const blob = await convertBlobToWebp(this.imageFile, WEBP_QUALITY, scale);
		if (token !== this.previewToken) {
			return;
		}

		this.currentScale = scale;
		this.currentBlob = blob;
		this.previewReady = true;

		const withinLimit = blob.size <= MAX_IMAGE_SIZE_BYTES;
		renderPreviewStatus(statusEl, scale, blob.size, withinLimit, this.dimensions);
		confirmButton.setDisabled(!withinLimit);
	}
}

async function getImageDimensions(blob) {
	const imageSource = await loadImageSource(blob);

	try {
		const width = imageSource.naturalWidth || imageSource.width;
		const height = imageSource.naturalHeight || imageSource.height;
		if (!width || !height) {
			throw new Error("Decoded image has invalid dimensions.");
		}

		return { width, height };
	} finally {
		if (typeof imageSource.close === "function") {
			imageSource.close();
		}
	}
}

async function loadImageSource(blob) {
	const objectUrl = URL.createObjectURL(blob);

	try {
		const image = await new Promise((resolve, reject) => {
			const element = new Image();
			element.decoding = "async";
			element.onload = () => resolve(element);
			element.onerror = () => reject(new Error("Image decode failed."));
			element.src = objectUrl;
		});

		return image;
	} catch (error) {
		throw error;
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

function getErrorMessage(error) {
	if (error && typeof error.message === "string" && error.message) {
		return error.message;
	}

	return String(error);
}

function formatBytes(bytes) {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function clampScale(value) {
	const numericValue = Number.parseInt(String(value), 10);
	if (!Number.isFinite(numericValue)) {
		return 100;
	}

	return Math.min(100, Math.max(1, numericValue));
}

function renderPreviewStatus(statusEl, scale, sizeBytes, withinLimit, dimensions) {
	statusEl.empty();
	statusEl.createEl("p", { text: `缩放比例：${scale}%` });
	if (dimensions) {
		const scaled = scaleDimensions(dimensions, scale);
		statusEl.createEl("p", {
			text: `缩放后分辨率：${scaled.width} x ${scaled.height}`
		});
	}
	statusEl.createEl("p", { text: `WebP 大小：${formatBytes(sizeBytes)}` });
	statusEl.createEl("p", {
		text: withinLimit
			? "已满足 1 MB 限制，可以确认粘贴。"
			: "仍超过 1 MB，请继续降低百分比。"
	});
}

function scaleDimensions(dimensions, scale) {
	return {
		width: Math.max(1, Math.round((dimensions.width * scale) / 100)),
		height: Math.max(1, Math.round((dimensions.height * scale) / 100))
	};
}

function debounce(fn, waitMs) {
	let timeoutId = null;

	return (...args) =>
		new Promise((resolve, reject) => {
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
			}

			timeoutId = window.setTimeout(async () => {
				timeoutId = null;
				try {
					resolve(await fn(...args));
				} catch (error) {
					reject(error);
				}
			}, waitMs);
		});
}

function crc32Hex(arrayBuffer) {
	const bytes = new Uint8Array(arrayBuffer);
	let crc = 0xffffffff;

	for (let index = 0; index < bytes.length; index += 1) {
		const tableIndex = (crc ^ bytes[index]) & 0xff;
		crc = (crc >>> 8) ^ CRC32_TABLE[tableIndex];
	}

	return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function buildCrc32Table() {
	const table = new Uint32Array(256);

	for (let n = 0; n < 256; n += 1) {
		let c = n;

		for (let k = 0; k < 8; k += 1) {
			c = (c & 1) === 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		}

		table[n] = c >>> 0;
	}

	return table;
}
