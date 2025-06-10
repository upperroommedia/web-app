#!/usr/bin/env python3
"""
Script to extract Subsplash IDs from log entries containing failed update errors.
Ignores entries with "undefined" IDs and saves valid IDs to subsplashIds.json
"""

import json
import re
import sys
from typing import List, Set

def extract_subsplash_ids(input_file: str) -> List[str]:
    """
    Extract Subsplash IDs from JSON log file.
    
    Args:
        input_file: Path to the input JSON file
        
    Returns:
        List of unique Subsplash IDs
    """
    subsplash_ids: Set[str] = set()
    
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
        # Handle both single objects and arrays of objects
        if isinstance(data, dict):
            entries = [data]
        elif isinstance(data, list):
            entries = data
        else:
            print(f"Error: Unexpected JSON structure in {input_file}")
            return []
            
        for entry in entries:
            # Look for textPayload field
            text_payload = entry.get('textPayload', '')
            
            if 'Failed to update Subsplash sermon' in text_payload:
                # Skip entries with "undefined"
                if 'Failed to update Subsplash sermon undefined' in text_payload:
                    print(f"Skipping entry with undefined sermon ID")
                    continue
                
                # Extract UUID pattern after "Failed to update Subsplash sermon "
                pattern = r'Failed to update Subsplash sermon ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})'
                match = re.search(pattern, text_payload)
                
                if match:
                    subsplash_id = match.group(1)
                    subsplash_ids.add(subsplash_id)
                    print(f"Found Subsplash ID: {subsplash_id}")
                
    except FileNotFoundError:
        print(f"Error: File {input_file} not found")
        return []
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in {input_file}: {e}")
        return []
    except Exception as e:
        print(f"Error processing {input_file}: {e}")
        return []
    
    return sorted(list(subsplash_ids))

def save_ids_to_file(ids: List[str], output_file: str = 'subsplashIds.json') -> None:
    """
    Save Subsplash IDs to JSON file.
    
    Args:
        ids: List of Subsplash IDs to save
        output_file: Output file path
    """
    try:
        output_data = {
            "subsplashIds": ids,
            "count": len(ids),
            "description": "Extracted Subsplash IDs from failed update logs"
        }
        
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)
            
        print(f"Successfully saved {len(ids)} Subsplash IDs to {output_file}")
        
    except Exception as e:
        print(f"Error saving to {output_file}: {e}")

def main():
    """Main function to process command line arguments and run extraction."""
    if len(sys.argv) != 2:
        print("Usage: python extract_subsplash_ids.py <input_json_file>")
        print("Example: python extract_subsplash_ids.py logs.json")
        sys.exit(1)
    
    input_file = sys.argv[1]
    print(f"Processing {input_file}...")
    
    # Extract IDs
    ids = extract_subsplash_ids(input_file)
    
    if not ids:
        print("No Subsplash IDs found or error occurred")
        sys.exit(1)
    
    # Save to output file
    save_ids_to_file(ids)
    
    print(f"Extraction complete! Found {len(ids)} unique Subsplash IDs")

if __name__ == "__main__":
    main() 