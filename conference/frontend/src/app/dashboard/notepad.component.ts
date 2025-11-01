import { Component, OnInit, OnDestroy, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from '@codemirror/language';

interface EditorTab {
  id: string;
  name: string;
  language: string;
  content: string;
  isActive: boolean;
}

interface LanguageOption {
  value: string;
  label: string;
  extension: any;
}

interface PopupData {
  type: 'alert' | 'confirm' | 'prompt';
  title: string;
  message: string;
  inputValue?: string;
  inputPlaceholder?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: (value?: string) => void;
  onCancel?: () => void;
}

@Component({
  selector: 'app-notepad',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './notepad.component.html',
  styleUrls: ['./notepad.component.scss']
})
export class NotepadComponent implements OnInit, OnDestroy, AfterViewInit {
  @Output() close = new EventEmitter<void>();
  @ViewChild('editorContainer', { static: false }) editorContainer!: ElementRef;

  tabs: EditorTab[] = [];
  activeTabId: string = '';
  editorView: EditorView | null = null;
  isDarkTheme: boolean = true;
  isFullscreen: boolean = false;
  showSettings: boolean = false;
  
  // Popup state
  showPopup: boolean = false;
  popupData: PopupData | null = null;
  popupInputValue: string = '';
  
  languageCompartment = new Compartment();
  themeCompartment = new Compartment();

  languages: LanguageOption[] = [
    { value: 'plaintext', label: 'Plain Text', extension: null },
    { value: 'javascript', label: 'JavaScript', extension: javascript },
    { value: 'typescript', label: 'TypeScript', extension: javascript({ typescript: true }) },
    { value: 'python', label: 'Python', extension: python },
    { value: 'html', label: 'HTML', extension: html },
    { value: 'css', label: 'CSS', extension: css },
    { value: 'json', label: 'JSON', extension: json },
    { value: 'markdown', label: 'Markdown', extension: markdown },
  ];

  constructor() {}

  ngOnInit(): void {
    this.loadFromLocalStorage();
    
    // Create default tabs if none exist
    if (this.tabs.length === 0) {
      this.addTab('Notes', 'plaintext');
      this.addTab('Code', 'javascript');
    }
    
    // Set first tab as active
    if (this.tabs.length > 0 && !this.activeTabId) {
      this.activeTabId = this.tabs[0].id;
      this.tabs[0].isActive = true;
    }
  }

  ngAfterViewInit(): void {
    // Initialize editor after view is ready
    setTimeout(() => {
      this.initializeEditor();
    }, 100);
  }

  ngOnDestroy(): void {
    this.saveToLocalStorage();
    if (this.editorView) {
      this.editorView.destroy();
    }
  }

  private initializeEditor(): void {
    if (!this.editorContainer) return;

    const activeTab = this.getActiveTab();
    if (!activeTab) return;

    const languageExtension = this.getLanguageExtension(activeTab.language);
    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        ...completionKeymap,
        ...closeBracketsKeymap,
        ...lintKeymap,
        indentWithTab
      ]),
      this.languageCompartment.of(languageExtension ? [languageExtension()] : []),
      this.themeCompartment.of(this.isDarkTheme ? oneDark : []),
      EditorView.updateListener.of((update: any) => {
        if (update.docChanged) {
          this.onEditorChange(update.state.doc.toString());
        }
      }),
      // Enable scrolling with custom theme
      EditorView.theme({
        "&": {
          height: "100%"
        },
        ".cm-scroller": {
          overflow: "auto"
        }
      })
    ];

    const state = EditorState.create({
      doc: activeTab.content,
      extensions
    });

    this.editorView = new EditorView({
      state,
      parent: this.editorContainer.nativeElement
    });
  }

  private getLanguageExtension(language: string): any {
    const lang = this.languages.find(l => l.value === language);
    return lang?.extension || null;
  }

  private onEditorChange(content: string): void {
    const activeTab = this.getActiveTab();
    if (activeTab) {
      activeTab.content = content;
      this.autoSave();
    }
  }

  addTab(name?: string, language?: string): void {
    const tabCount = this.tabs.length + 1;
    const newTab: EditorTab = {
      id: `tab-${Date.now()}`,
      name: name || `Untitled ${tabCount}`,
      language: language || 'plaintext',
      content: '',
      isActive: false
    };

    this.tabs.push(newTab);
    this.switchTab(newTab.id);
    this.saveToLocalStorage();
  }

  switchTab(tabId: string): void {
    // Save current editor content before switching
    if (this.editorView) {
      const currentTab = this.getActiveTab();
      if (currentTab) {
        currentTab.content = this.editorView.state.doc.toString();
      }
    }

    // Update active tab
    this.tabs.forEach(tab => {
      tab.isActive = tab.id === tabId;
    });
    this.activeTabId = tabId;

    // Update editor with new tab content
    const newActiveTab = this.getActiveTab();
    if (newActiveTab && this.editorView) {
      const languageExtension = this.getLanguageExtension(newActiveTab.language);
      
      this.editorView.dispatch({
        changes: {
          from: 0,
          to: this.editorView.state.doc.length,
          insert: newActiveTab.content
        },
        effects: [
          this.languageCompartment.reconfigure(languageExtension ? [languageExtension()] : [])
        ]
      });
    }

    this.saveToLocalStorage();
  }

  closeTab(tabId: string, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }

    const index = this.tabs.findIndex(t => t.id === tabId);
    if (index === -1) return;

    // Don't close if it's the last tab
    if (this.tabs.length === 1) {
      this.showAlertPopup('Cannot Close Tab', 'You cannot close the last tab. At least one tab must remain open.');
      return;
    }

    this.tabs.splice(index, 1);

    // If closed tab was active, switch to another tab
    if (tabId === this.activeTabId) {
      const newActiveIndex = Math.max(0, index - 1);
      this.switchTab(this.tabs[newActiveIndex].id);
    }

    this.saveToLocalStorage();
  }

  renameTab(tabId: string): void {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    this.showPromptPopup(
      'Rename Tab',
      'Enter a new name for this tab:',
      tab.name,
      (newName) => {
        if (newName && newName.trim()) {
          tab.name = newName.trim();
          this.saveToLocalStorage();
        }
      }
    );
  }

  changeLanguage(language: string): void {
    const activeTab = this.getActiveTab();
    if (!activeTab) return;

    activeTab.language = language;
    
    if (this.editorView) {
      const languageExtension = this.getLanguageExtension(language);
      this.editorView.dispatch({
        effects: this.languageCompartment.reconfigure(languageExtension ? [languageExtension()] : [])
      });
    }

    this.saveToLocalStorage();
  }

  toggleTheme(): void {
    this.isDarkTheme = !this.isDarkTheme;
    
    if (this.editorView) {
      this.editorView.dispatch({
        effects: this.themeCompartment.reconfigure(this.isDarkTheme ? oneDark : [])
      });
    }

    this.saveToLocalStorage();
  }

  toggleFullscreen(): void {
    this.isFullscreen = !this.isFullscreen;
  }

  exportFile(): void {
    const activeTab = this.getActiveTab();
    if (!activeTab) return;

    const content = this.editorView?.state.doc.toString() || activeTab.content;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTab.name}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  importFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.js,.ts,.py,.html,.css,.json,.md';
    
    input.onchange = (e: any) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event: any) => {
        const content = event.target.result;
        const fileName = file.name.replace(/\.[^/.]+$/, '');
        const extension = file.name.split('.').pop()?.toLowerCase();
        
        let language = 'plaintext';
        if (extension === 'js') language = 'javascript';
        else if (extension === 'ts') language = 'typescript';
        else if (extension === 'py') language = 'python';
        else if (extension === 'html') language = 'html';
        else if (extension === 'css') language = 'css';
        else if (extension === 'json') language = 'json';
        else if (extension === 'md') language = 'markdown';

        this.addTab(fileName, language);
        const activeTab = this.getActiveTab();
        if (activeTab && this.editorView) {
          activeTab.content = content;
          this.editorView.dispatch({
            changes: {
              from: 0,
              to: this.editorView.state.doc.length,
              insert: content
            }
          });
        }
      };
      reader.readAsText(file);
    };
    
    input.click();
  }

  clearContent(): void {
    this.showConfirmPopup(
      'Clear Content',
      'Are you sure you want to clear all content in the current tab? This action cannot be undone.',
      () => {
        const activeTab = this.getActiveTab();
        if (activeTab && this.editorView) {
          activeTab.content = '';
          this.editorView.dispatch({
            changes: {
              from: 0,
              to: this.editorView.state.doc.length,
              insert: ''
            }
          });
          this.saveToLocalStorage();
        }
      }
    );
  }

  private getActiveTab(): EditorTab | undefined {
    return this.tabs.find(t => t.id === this.activeTabId);
  }

  private autoSave(): void {
    // Debounced auto-save
    if ((this as any).autoSaveTimeout) {
      clearTimeout((this as any).autoSaveTimeout);
    }
    (this as any).autoSaveTimeout = setTimeout(() => {
      this.saveToLocalStorage();
    }, 1000);
  }

  private saveToLocalStorage(): void {
    try {
      const data = {
        tabs: this.tabs,
        activeTabId: this.activeTabId,
        isDarkTheme: this.isDarkTheme
      };
      localStorage.setItem('notepad-data', JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save to localStorage:', error);
    }
  }

  private loadFromLocalStorage(): void {
    try {
      const data = localStorage.getItem('notepad-data');
      if (data) {
        const parsed = JSON.parse(data);
        this.tabs = parsed.tabs || [];
        this.activeTabId = parsed.activeTabId || '';
        this.isDarkTheme = parsed.isDarkTheme !== undefined ? parsed.isDarkTheme : true;
      }
    } catch (error) {
      console.error('Failed to load from localStorage:', error);
    }
  }

  closeNotepad(): void {
    this.saveToLocalStorage();
    this.close.emit();
  }

  get activeTab(): EditorTab | undefined {
    return this.getActiveTab();
  }

  // Popup methods
  private showAlertPopup(title: string, message: string): void {
    this.popupData = {
      type: 'alert',
      title,
      message,
      confirmText: 'OK'
    };
    this.showPopup = true;
  }

  private showConfirmPopup(title: string, message: string, onConfirm: () => void, onCancel?: () => void): void {
    this.popupData = {
      type: 'confirm',
      title,
      message,
      confirmText: 'Yes',
      cancelText: 'No',
      onConfirm,
      onCancel
    };
    this.showPopup = true;
  }

  private showPromptPopup(title: string, message: string, defaultValue: string, onConfirm: (value?: string) => void, onCancel?: () => void): void {
    this.popupInputValue = defaultValue;
    this.popupData = {
      type: 'prompt',
      title,
      message,
      inputValue: defaultValue,
      inputPlaceholder: 'Enter value...',
      confirmText: 'OK',
      cancelText: 'Cancel',
      onConfirm,
      onCancel
    };
    this.showPopup = true;
  }

  closePopup(): void {
    this.showPopup = false;
    this.popupData = null;
    this.popupInputValue = '';
  }

  handlePopupConfirm(): void {
    if (!this.popupData) return;

    if (this.popupData.type === 'prompt') {
      this.popupData.onConfirm?.(this.popupInputValue);
    } else {
      this.popupData.onConfirm?.();
    }

    this.closePopup();
  }

  handlePopupCancel(): void {
    this.popupData?.onCancel?.();
    this.closePopup();
  }

  onPopupKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.handlePopupCancel();
    } else if (event.key === 'Enter' && this.popupData?.type !== 'prompt') {
      this.handlePopupConfirm();
    }
  }

  onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.handlePopupConfirm();
    }
  }
}
