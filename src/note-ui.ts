// The dialogs for notes and images on topics: a modal to write a topic's
// note, and a fuzzy finder over the vault's images. The view does the saving,
// so each change is one undo step.
//
// Field names are prefixed (mmNote…, mmImage…) so none of them shadows a
// member of Obsidian's Modal, SuggestModal or FuzzySuggestModal (app.js 1.14).

import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";
import { isImageFile } from "./note-helpers";

// Writes a topic's note. Ctrl/Cmd+Enter or Save keeps it, Escape or Cancel
// leaves it as it was, and saving an empty note removes it.
export class NoteModal extends Modal {
	// Focus goes back where it was (the map) when the dialog closes, so keys
	// like Escape and Delete keep working without another click.
	private mmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

	private mmNoteSaved = false;

	constructor(
		app: App,
		private mmNoteTopic: string,
		private mmNoteInitial: string,
		private mmNoteOnSave: (text: string) => void,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.mmNoteInitial ? "Edit note" : "Add note");
		this.modalEl?.addClass("mm-note-modal");
		if (this.mmNoteTopic) this.contentEl.createDiv({ cls: "mm-note-modal-topic", text: this.mmNoteTopic });
		const area = this.contentEl.createEl("textarea", {
			cls: "mm-note-input",
			attr: { rows: "8", placeholder: "Write a note. Markdown and [[links]] work.", "aria-label": "Note" },
		});
		area.value = this.mmNoteInitial;
		const save = () => {
			if (this.mmNoteSaved) return;
			this.mmNoteSaved = true;
			this.mmNoteOnSave(area.value);
			this.close();
		};
		area.addEventListener("keydown", (e) => {
			if (e.isComposing) return;
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				save();
			}
		});
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		actions.createEl("button", { cls: "mod-cta", text: "Save" }).onclick = save;
		actions.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		this.contentEl.createDiv({ cls: "mm-note-modal-hint", text: "Ctrl/Cmd+Enter saves. An empty note is removed." });
		window.setTimeout(() => {
			area.focus();
			area.setSelectionRange(area.value.length, area.value.length);
		}, 0);
	}

	onClose() {
		this.contentEl.empty();
		const back = this.mmReturnFocus;
		window.setTimeout(() => back?.isConnected && back.focus(), 0);
	}
}

// Picks one of the vault's images.
export class ImageSuggestModal extends FuzzySuggestModal<TFile> {
	private mmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

	constructor(
		app: App,
		private mmImageOnChoose: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("Find an image to show in this topic");
		this.emptyStateText = "No images in this vault.";
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => isImageFile(f.extension))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.mmImageOnChoose(file);
	}

	onClose(): void {
		super.onClose();
		const back = this.mmReturnFocus;
		window.setTimeout(() => back?.isConnected && back.focus(), 0);
	}
}
