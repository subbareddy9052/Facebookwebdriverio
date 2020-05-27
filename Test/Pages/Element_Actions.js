class Elementactions{

    doClick(element){
        element.waitForDisplayed()
        element.click()
    }
    
    doSetvalue(element,value){
        element.waitForDisplayed()
        element.setValue(value)
    }

    dogettext(element){
        element.waitForDisplayed()
        return element.getText()
    }


    dogetpagetitle(){
        return browser.getTitle()
    }

}