import re
import time
import json
import requests
import urllib.parse
import pandas as pd
from os.path import exists
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support import expected_conditions as EC


def handle_nan(value):
    return value if str(value) != 'nan' else ''


current_page = 1
url = f'https://dashboard.subsplash.com/-d/#/library/media/items?page={current_page}'

s = Service(executable_path='./chromedriver')
driver = webdriver.Chrome(service=s)
driver.get(url)

WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.ID, "email")))
email = driver.find_element(By.ID, "email")
email.click()
time.sleep(1)

ActionChains(driver).send_keys("username" + Keys.TAB + "password" + Keys.ENTER).perform()
time.sleep(2)

driver.get(url)
WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.CLASS_NAME, "route-app__main")))
time.sleep(1)

# still need to get full csv of every talk
df = pd.read_csv("./2021-feb112022.csv")

# if data.json doesn't exist already
if not exists('./data.json'):
    data1 = {'talks': []}
    with open('data.json', 'w+') as outfile:
        json.dump(data1, outfile)

last_page = driver.find_elements(By.XPATH, "//div[@class='kit-pagination__page ']")
last_page = int(last_page[len(last_page)-1].text)

while current_page != last_page:
    print(f'currently on page {current_page}')

    # after index 1 and ends at index len(links)-4
    page = driver.find_element(By.CLASS_NAME, "ember-view")
    links = page.find_elements(By.TAG_NAME, 'a')

    for link_i in range(len(links[1:len(links)-4])):
        WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.XPATH, "//div[@class='kit-overlay ember-view route-library-media-overview__stack-nav-overlay']")))

        page = driver.find_element(By.CLASS_NAME, "ember-view")
        links = page.find_elements(By.TAG_NAME, 'a')

        links[link_i+2].click()
        WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.XPATH, "//div[@class='kit-copy-text__text']")))

        share_link = driver.find_element(By.XPATH, "//div[@class='kit-copy-text__text']")
        req = requests.get(share_link.text)

        soup = BeautifulSoup(req.content, 'html.parser')
        if not soup.audio:
            driver.back()
            continue
        audio_src = soup.audio.source['src']

        download_id = re.findall("https://cdn.subsplash.com/audios/[0-9A-Z]*/([a-z0-9-]*)", audio_src)[0]
        sub_id = re.findall("https://dashboard.subsplash.com/-d/#/library/media/items/([0-9a-z-]*)", driver.current_url)[0]

        current_row = df.loc[df['sub_id'] == sub_id]

        title = handle_nan(current_row['title'].values[0])
        summary = handle_nan(current_row['summary'].values[0])
        subtitle = handle_nan(current_row['subtitle'].values[0])
        add_labels = handle_nan(current_row['add_labels'].values[0])
        date = handle_nan(current_row['date'].values[0])
        speakers = handle_nan(current_row['speakers'].values[0])
        topics = handle_nan(current_row['topics'].values[0]).split("|")
        scripture = handle_nan(current_row['scripture'].values[0])
        published = handle_nan(current_row['published'].values[0])

        try:
            image_src = soup.find_all("meta", {'property': "og:image"})[0]['content']
            image_width = soup.find_all("meta", {'property': "og:image:width"})[0]['content']
            image_height = soup.find_all("meta", {'property': "og:image:height"})[0]['content']
        except:
            image_src = ""
            image_width = ""
            image_height = ""

        data = {
            'title': title,
            'summary': summary,
            'subtitle': subtitle,
            'add_labels': add_labels,
            'date': date,
            'speakers': speakers,
            'topics': topics,
            'scripture': scripture,
            'published': 1 if published == 'yes' else 0,
            'image': {
                'image_src': image_src,
                'image_width': image_width,
                'image_height': image_height
            },
            'download_url': f'https://core.subsplash.com/files/download?type=audio-outputs&id={download_id}&filename={urllib.parse.quote(title)}.mp3'
        }

        with open('data.json', 'r+') as file:
            file_data = json.load(file)
            file_data["talks"].append(data)
            file.seek(0)
            json.dump(file_data, file, indent=4)

        driver.back()

    current_page += 1
    url = f'https://dashboard.subsplash.com/-d/#/library/media/items?page={current_page}'
    driver.get(url)
    WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.CLASS_NAME, "route-app__main")))
    time.sleep(1)
