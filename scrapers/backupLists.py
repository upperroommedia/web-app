import requests
import json
import os
import asyncio
import aiohttp
from datetime import date
from helpers.authenticateSubsplash import authenticateSubsplash

async def fetch(url, headers):
  async with aiohttp.ClientSession(headers=headers) as session:
    async with session.get(url) as response:
      return response


async def write_to_file(filename, content):
  os.makedirs(os.path.dirname(filename), exist_ok=True)
  with open(filename, 'w') as f:
    f.write(content)

async def download_and_write(list, headers, backup_folder_path):
  folder_name = f"{list['title'].strip().replace(' ', '_')}_{list['id']}"
  file_name = "metadata"
  file_path = os.path.abspath(os.path.join(backup_folder_path, folder_name, file_name))
  # write metadata to file
  await write_to_file(file_path, json.dumps(list, indent=4))
  print(f"Wrote metadata to: {folder_name}/{file_name}")
  
  # get media items
  list_item_page_number = 1
  count = 0
  loop = True
  list_rows = []
  while (loop):
    print(f"Getting list items for {list['title']} (page {list_item_page_number}): current count: {count}")
    url = f"https://core.subsplash.com/builder/v1/list-rows?filter%5Bsource_list%5D={list['id']}&page%5Bnumber%5D={list_item_page_number}&page%5Bsize%5D=100"
    async with aiohttp.ClientSession(headers=headers) as session:
      async with session.get(url) as response:
        if response.status != 200:
          file_name = "error"
          file_path = os.path.abspath(os.path.join(backup_folder_path, folder_name, file_name))
          await write_to_file(file_path, await response.text())
          loop = False
          continue
        list_rows_response = await response.json()
        count += list_rows_response['count']
        if (list_item_page_number > 1):
          print(f"Retrieved {count} of {list_rows_response['total']} list items for {list['title']}_{list['id']}")
        if (count >= list_rows_response['total'] or count == 0 or list_item_page_number * 100 >= list_rows_response['total']):
          if (count == 0):
            print(f"No list items found for {list['title']}_{list['id']}")
          loop = False
        list_item_page_number += 1
        list_rows += list_rows_response['_embedded']['list-rows']

  file_name = "list_rows"
  file_path = os.path.abspath(os.path.join(backup_folder_path, folder_name, file_name))
  await write_to_file(file_path, json.dumps(list_rows, indent=4))
  print(f"Wrote {count} list_rows to: {folder_name}/{file_name}")


async def download_and_write_all(backup_folder_path):
  print("Getting lists")
  page_size = 2000
  count = 0
  page_number = 1
  loop = True
  while (loop):
    headers = {
      'Authorization': f'Bearer {authenticateSubsplash()}'
    }
    url = f'https://core.subsplash.com/builder/v1/lists?filter%5Bapp_key%5D=9XTSHD&filter%5Bgenerated%5D=false&filter%5Btype%5D=standard&page%5Bnumber%5D={page_number}&page%5Bsize%5D={page_size}&sort=title'
    response = requests.request("GET", url, headers=headers).json()
    count += response['count']
    print(f"Retrieved count of {response['total']} lists")
    if (count >= response['total'] or count == 0 or page_number * page_size >= response['total']):
      if (count == 0):
        print("No lists found")
      loop = False
    tasks = []
    for list in response['_embedded']['lists']:
        task = asyncio.create_task(download_and_write(list, headers, backup_folder_path))
        tasks.append(task)
    await asyncio.gather(*tasks)
    page_number += 1
  print(f"Done backing up {count} lists")


backup_folder_path = input('Enter backup folder path: ').strip("'")
if not os.path.exists(backup_folder_path):
  raise Exception(f"Backup folder path {backup_folder_path} does not exist. Please make sure the path is correct and try again.")
backup_folder_path = os.path.join(backup_folder_path, f'data_{date.today()}')
asyncio.run(download_and_write_all(backup_folder_path))