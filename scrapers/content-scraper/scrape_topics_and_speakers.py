import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support import expected_conditions as EC

page_number = 1

url = f'https://dashboard.subsplash.com/-d/#/library/tags/speakers?page={page_number}'

s = Service(executable_path='./chromedriver')
driver = webdriver.Chrome(service=s)
driver.get(url)

WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.ID, "email")))
email = driver.find_element(By.ID, "email")
email.click()
time.sleep(1)

ActionChains(driver).send_keys("email" + Keys.TAB + "password" + Keys.ENTER).perform()
time.sleep(2)

driver.get(url)
WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.CLASS_NAME, "route-app__main")))
time.sleep(1)

arr = []
while page_number < 31:
    time.sleep(3)
    items = driver.find_elements(By.CLASS_NAME, "kit-row-item__title")

    for i in items:
        arr.append(i.text)

    page_number += 1
    url = f'https://dashboard.subsplash.com/-d/#/library/tags/speakers?page={page_number}'
    driver.get(url)

print(arr)
