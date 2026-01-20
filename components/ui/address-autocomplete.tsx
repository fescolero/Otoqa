'use client';

import * as React from 'react';
import { MapPin, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from '@/components/ui/input-group';
import { getAddressPredictions, getPlaceDetails } from '@/lib/googlePlaces';

export interface AddressData {
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number;
  longitude?: number;
  formattedAddress?: string;
  timeZone?: string; // IANA timezone (e.g., "America/Los_Angeles")
}

interface AddressAutocompleteProps {
  value?: string;
  onSelect: (data: AddressData) => void;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function AddressAutocomplete({
  value = '',
  onSelect,
  onChange,
  placeholder = 'Start typing an address...',
  disabled = false,
  className,
}: AddressAutocompleteProps) {
  const [inputValue, setInputValue] = React.useState(value);
  const [predictions, setPredictions] = React.useState<google.maps.places.AutocompletePrediction[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [showDropdown, setShowDropdown] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(-1);
  const debounceRef = React.useRef<NodeJS.Timeout>();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Fetch predictions when input changes
  const fetchPredictions = async (query: string) => {
    if (!query || query.length < 3) {
      setPredictions([]);
      setShowDropdown(false);
      return;
    }

    setIsLoading(true);
    try {
      const results = await getAddressPredictions(query);
      setPredictions(results);
      setShowDropdown(results.length > 0);
      setSelectedIndex(-1);
    } catch (error) {
      console.error('Failed to fetch predictions:', error);
      setPredictions([]);
      setShowDropdown(false);
    } finally {
      setIsLoading(false);
    }
  };

  // Debounce the predictions fetch
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setInputValue(query);
    
    // Notify parent of manual input changes
    if (onChange) {
      onChange(query);
    }
    
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      fetchPredictions(query);
    }, 300);
  };

  // Handle address selection
  const handleSelect = async (placeId: string, description: string) => {
    setIsLoading(true);
    setShowDropdown(false);
    try {
      const details = await getPlaceDetails(placeId);
      if (details) {
        const addressData: AddressData = {
          address: details.address,
          city: details.city,
          state: details.state,
          postalCode: details.postalCode,
          country: details.country,
          latitude: details.latitude,
          longitude: details.longitude,
          formattedAddress: details.formattedAddress,
          timeZone: details.timeZone,
        };
        console.log('📍 Calling onSelect with:', addressData);
        onSelect(addressData);
        setInputValue(details.formattedAddress);
      } else {
        setInputValue(description);
      }
    } catch (error) {
      console.error('Failed to get place details:', error);
      setInputValue(description);
    } finally {
      setIsLoading(false);
      setPredictions([]);
    }
  };

  // Clear input
  const handleClear = () => {
    setInputValue('');
    setPredictions([]);
    setShowDropdown(false);
    setSelectedIndex(-1);
    inputRef.current?.focus();
  };

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || predictions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => (prev < predictions.length - 1 ? prev + 1 : prev));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && predictions[selectedIndex]) {
          const prediction = predictions[selectedIndex];
          handleSelect(prediction.place_id, prediction.description);
        }
        break;
      case 'Escape':
        setShowDropdown(false);
        setSelectedIndex(-1);
        break;
    }
  };

  // Click outside to close dropdown
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false);
        setSelectedIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Update input value when prop changes
  React.useEffect(() => {
    if (value) {
      setInputValue(value);
    }
  }, [value]);

  return (
    <div className={cn('relative w-full', className)}>
      <InputGroup>
        <InputGroupAddon>
          <MapPin className="h-4 w-4 text-muted-foreground" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (predictions.length > 0) {
              setShowDropdown(true);
            }
          }}
          disabled={disabled}
          autoComplete="off"
          className="pr-20"
        />
        <InputGroupAddon align="inline-end">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mr-2" />}
          {inputValue && (
            <InputGroupButton
              type="button"
              onClick={handleClear}
              size="icon-xs"
              variant="ghost"
              aria-label="Clear address"
              className="h-6 w-6"
            >
              <X className="h-3 w-3" />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>

      {/* Dropdown with suggestions */}
      {showDropdown && predictions.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-[300px] overflow-auto"
        >
          {predictions.map((prediction, index) => (
            <div
              key={prediction.place_id}
              onClick={() => handleSelect(prediction.place_id, prediction.description)}
              onMouseEnter={() => setSelectedIndex(index)}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors',
                'hover:bg-accent',
                selectedIndex === index && 'bg-accent',
                index !== predictions.length - 1 && 'border-b'
              )}
            >
              <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm truncate">{prediction.description}</span>
            </div>
          ))}
        </div>
      )}

      {/* No results message */}
      {showDropdown && !isLoading && predictions.length === 0 && inputValue.length >= 3 && (
        <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg p-3">
          <p className="text-sm text-muted-foreground text-center">
            No addresses found. Try a different search.
          </p>
        </div>
      )}
    </div>
  );
}
