import requests
import json
import os
from .authenticateSubsplash import authenticateSubsplash


def getTags(type: str):
  types = ['speaker', 'topic']
  if type not in types:
    raise ValueError('type must be one of: ' + ', '.join(types))
  
  page_number = 1
  page_size = 100
  loop = True
  current = 0
  headers = {
    'collection-total': 'include',
    'Authorization': f'Bearer {authenticateSubsplash()}'
  }
  clean_tags = []
  while loop:
    url = f"https://core.subsplash.com/tags/v1/tags?filter%5Bapp_key%5D=9XTSHD&filter%5Btype%5D={type}&include=image&page%5Bnumber%5D={page_number}&page%5Bsize%5D={page_size}&sort=title"
    response = requests.request("GET", url, headers=headers).json()
    current += response['count']
    print(f"Retrieved {current} of {response['total']} {type} tags")
    page_number += 1
    if current >= response['total']:
      loop = False
    raw_tags = response['_embedded']['tags']
    for tag in raw_tags:
      filtered_tag = {
        f'{type}Id': tag['id'],
        'name': tag['title'],
        'sermonCount': tag['tagging_count'],
      }
      clean_tags.append(filtered_tag)
      
  file_name = f'subsplash{type.capitalize()}Tags.json'
  file_path = os.path.join(os.path.dirname(__file__), '../data', file_name)
  with open(file_path, 'w') as file:
    print(f"Wrote results to: {file_path}")
    file.write(json.dumps(clean_tags, indent=4))
  


