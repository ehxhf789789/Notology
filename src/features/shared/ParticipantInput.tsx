import { useState, useRef, useEffect, useCallback } from 'react';
import { searchCommands } from '../../core/services/tauriCommands';
import { useSettingsStore } from '../../core/stores/settingsStore';
import { t } from '../../core/utils/i18n';

interface ContactInfo {
  displayName: string;
  fileName: string;
  path: string;
  organization?: string;
}

interface NoteMetadata {
  path: string;
  note_type: string;
  title?: string;
}

// Participant can be a contact (with wikilink) or plain text
interface Participant {
  id: string;
  displayName: string;
  fileName?: string; // If from contact, has fileName for wiki-link
  isContact: boolean;
}

interface ParticipantInputProps {
  value: string; // Wiki-link format string for storage
  onChange: (value: string) => void;
  placeholder?: string;
}

// Parse wiki-link format string to participants array
function parseParticipants(value: string): Participant[] {
  if (!value.trim()) return [];

  const participants: Participant[] = [];
  // Match [[fileName|displayName]] or legacy [[fileName|@displayName]] format
  const wikiLinkRegex = /\[\[([^\]|]+)\|@?([^\]]+)\]\]/g;

  let lastIndex = 0;
  let match;

  while ((match = wikiLinkRegex.exec(value)) !== null) {
    // Add any plain text before this match
    const textBefore = value.substring(lastIndex, match.index).trim();
    if (textBefore) {
      textBefore.split(',').forEach(name => {
        const trimmed = name.trim();
        if (trimmed) {
          participants.push({
            id: `plain-${trimmed}-${Date.now()}-${Math.random()}`,
            displayName: trimmed,
            isContact: false,
          });
        }
      });
    }

    // Add the wiki-link participant
    participants.push({
      id: `contact-${match[1]}`,
      displayName: match[2],
      fileName: match[1],
      isContact: true,
    });

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining plain text
  const remaining = value.substring(lastIndex).trim();
  if (remaining) {
    remaining.split(',').forEach(name => {
      const trimmed = name.trim();
      if (trimmed) {
        participants.push({
          id: `plain-${trimmed}-${Date.now()}-${Math.random()}`,
          displayName: trimmed,
          isContact: false,
        });
      }
    });
  }

  return participants;
}

// Convert participants array to wiki-link format string
function serializeParticipants(participants: Participant[]): string {
  return participants.map(p => {
    if (p.isContact && p.fileName) {
      return `[[${p.fileName}|${p.displayName}]]`;
    }
    return p.displayName;
  }).join(', ');
}

function ParticipantInput({ value, onChange, placeholder }: ParticipantInputProps) {
  const language = useSettingsStore(s => s.language);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<ContactInfo[]>([]);
  const [allContacts, setAllContacts] = useState<ContactInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Initialize participants from value
  useEffect(() => {
    setParticipants(parseParticipants(value));
  }, [value]);

  // Load all contacts on mount
  useEffect(() => {
    const loadContacts = async () => {
      try {
        const notes = await searchCommands.queryNotes({});
        const contacts: ContactInfo[] = [];

        for (const note of notes) {
          if (note.note_type === 'CONTACT') {
            const fileName = note.path.split(/[/\\]/).pop()?.replace(/\.md$/, '') || '';
            contacts.push({
              displayName: (note.title || fileName).replace(/_/g, ' '),
              fileName,
              path: note.path,
            });
          }
        }

        setAllContacts(contacts);
      } catch (err) {
        console.error('Failed to load contacts:', err);
      }
    };

    loadContacts();
  }, []);

  // Search contacts — always searches as you type, no @ prefix needed
  const searchContacts = useCallback((query: string): ContactInfo[] => {
    const lowerQuery = query.toLowerCase();
    return allContacts
      .filter(contact =>
        contact.displayName.toLowerCase().includes(lowerQuery) ||
        contact.fileName.toLowerCase().includes(lowerQuery)
      )
      .filter(contact => !participants.some(p => p.fileName === contact.fileName)) // Exclude already added
      .slice(0, 8);
  }, [allContacts, participants]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);

    // Auto-search contacts as user types (no @ prefix required)
    const trimmed = newValue.trim();
    if (trimmed.length > 0) {
      const results = searchContacts(trimmed);
      setSuggestions(results);
      setShowSuggestions(results.length > 0);
      setSelectedIndex(0);
    } else {
      setShowSuggestions(false);
    }
  }, [searchContacts]);

  const addParticipant = useCallback((participant: Participant) => {
    const newParticipants = [...participants, participant];
    setParticipants(newParticipants);
    onChange(serializeParticipants(newParticipants));
    setInputValue('');
    setShowSuggestions(false);
    inputRef.current?.focus();
  }, [participants, onChange]);

  const selectContact = useCallback((contact: ContactInfo) => {
    addParticipant({
      id: `contact-${contact.fileName}`,
      displayName: contact.displayName,
      fileName: contact.fileName,
      isContact: true,
    });
  }, [addParticipant]);

  const addPlainText = useCallback(() => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      addParticipant({
        id: `plain-${trimmed}-${Date.now()}`,
        displayName: trimmed,
        isContact: false,
      });
    }
  }, [inputValue, addParticipant]);

  const removeParticipant = useCallback((id: string) => {
    const newParticipants = participants.filter(p => p.id !== id);
    setParticipants(newParticipants);
    onChange(serializeParticipants(newParticipants));
  }, [participants, onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showSuggestions && suggestions.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => (prev + 1) % suggestions.length);
          return;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
          return;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          if (suggestions[selectedIndex]) {
            selectContact(suggestions[selectedIndex]);
          }
          return;
        case 'Escape':
          e.preventDefault();
          setShowSuggestions(false);
          return;
      }
    }

    // Add plain text participant on Enter or comma
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addPlainText();
    }

    // Remove last participant on Backspace when input is empty
    if (e.key === 'Backspace' && !inputValue && participants.length > 0) {
      e.preventDefault();
      removeParticipant(participants[participants.length - 1].id);
    }
  }, [showSuggestions, suggestions, selectedIndex, selectContact, addPlainText, inputValue, participants, removeParticipant]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (showSuggestions && suggestionsRef.current) {
      const selectedItem = suggestionsRef.current.children[selectedIndex] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, showSuggestions]);

  return (
    <div className="participant-input-wrapper">
      <div className="participant-chips-container" onClick={() => inputRef.current?.focus()}>
        {participants.map(p => (
          <span key={p.id} className={`participant-chip ${p.isContact ? 'contact' : 'plain'}`}>
            <span className="participant-chip-name">{p.displayName}</span>
            <button
              type="button"
              className="participant-chip-remove"
              onClick={(e) => {
                e.stopPropagation();
                removeParticipant(p.id);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="participant-input-inline"
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // Add plain text on blur if not selecting from suggestions
            setTimeout(() => {
              if (!showSuggestions && inputValue.trim()) {
                addPlainText();
              }
            }, 150);
          }}
          placeholder={participants.length === 0 ? placeholder : t('participantPlaceholder', language)}
        />
      </div>
      {showSuggestions && suggestions.length > 0 && (
        <div ref={suggestionsRef} className="participant-suggestions">
          {suggestions.map((contact, index) => (
            <div
              key={contact.path}
              className={`participant-suggestion-item ${index === selectedIndex ? 'selected' : ''}`}
              onClick={() => selectContact(contact)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div className="participant-suggestion-avatar">
                {contact.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="participant-suggestion-info">
                <div className="participant-suggestion-name">{contact.displayName}</div>
                {contact.organization && (
                  <div className="participant-suggestion-org">{contact.organization}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ParticipantInput;
