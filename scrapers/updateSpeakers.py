from helpers.authenticateSubsplash import authenticateSubsplash
import requests
import json
token = authenticateSubsplash()
speaker_id = input('Enter speaker ID: ')
original_speaker = input('Enter original speaker name: ')
new_speaker = input('Enter new speaker name: ')
headers = {
  'Authorization': f'Bearer {authenticateSubsplash()}'
}
url = f"https://core.subsplash.com/tags/v1/taggings?filter%5Bapp_key%5D=9XTSHD&filter%5Btag.id%5D={speaker_id}&include=media-item&page%5Bnumber%5D=1&page%5Bsize%5D=100"
response = requests.request("GET", url, headers=headers).json()
ids_and_tags = [(tagging['_embedded']['media-item']['id'], tagging['_embedded']['media-item']['tags']) for tagging in response['_embedded']['taggings']]

for id, tags in ids_and_tags:
  new_tags =  [f'speaker:{new_speaker}' if tag == f'speaker:{original_speaker}' else tag for tag in tags]
  payload = json.dumps({
    "tags": new_tags
  })
  print(id, new_tags)
  response = requests.request("PATCH", f"https://core.subsplash.com/media/v1/media-items/{id}", headers=headers, data=payload)

print(f'Done migrating {len(ids_and_tags)} sermons')